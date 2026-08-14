import "reflect-metadata";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import {
    assertAppEnvExplicit,
    assertProductionEnv,
    positiveIntEnv,
    resolveAppEnv,
} from "@/config/env";
import { AppDataSource } from "@/database_bundle/util/data_source";

// Smallest valid PNG (1x1, transparent).
const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

const app = createApp();

/**
 * Generation runs in the background, so a freshly created case is PENDING and
 * the client polls. In test the generator returns a fixture with no model call,
 * so this resolves in a handful of ticks.
 */
async function pollUntilReady(id: string): Promise<request.Response> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await request(app).get(`/api/cases/${id}`);
        if (response.body.status !== "PENDING") {
            return response;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("case never left PENDING");
}

beforeAll(async () => {
    await AppDataSource.initialize();
});

afterAll(async () => {
    await AppDataSource.destroy();
});

describe("api wiring", () => {
    it("serves /health", async () => {
        const response = await request(app).get("/health");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });

    it("rejects a case request with no photo", async () => {
        const response = await request(app).post("/api/cases");
        expect(response.status).toBe(400);
    });

    it("accepts an upload without generating inline", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        // 202 and an id only: the case does not exist yet.
        expect(created.status).toBe(202);
        expect(created.body.id).toBeTruthy();
        expect(created.body.status).toBe("PENDING");
        expect(created.body.defendant).toBeUndefined();
        expect(created.body.truth).toBeUndefined();
    });

    it("serves a finished case back without the hidden truth", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        const fetched = await pollUntilReady(created.body.id);
        expect(fetched.status).toBe(200);
        expect(fetched.body.status).toBe("READY");
        expect(fetched.body.id).toBe(created.body.id);
        expect(fetched.body.truth).toBeUndefined();
        expect(fetched.body.nodes.length).toBeGreaterThan(0);
        expect(fetched.body.rootNodeId).toBeTruthy();
        // Tests must never write to the real bucket, whatever packages/api/.env holds.
        expect(fetched.body.defendant.photoUrl).toContain("data:image/png");
    });

    // A PENDING row still holds the placeholder bible. Serving it would put an
    // empty trial in front of the player, so the status arm carries no case at all.
    it("withholds the bible until the case is READY", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        const pending = await request(app).get(`/api/cases/${created.body.id}`);
        expect(pending.status).toBe(200);
        if (pending.body.status === "PENDING") {
            expect(pending.body.nodes).toBeUndefined();
            expect(pending.body.defendant).toBeUndefined();
            expect(pending.headers["cache-control"]).toBe("no-store");
        }

        // Whatever the timing, the case must finish and never leak the truth.
        const ready = await pollUntilReady(created.body.id);
        expect(ready.body.status).toBe("READY");
        expect(ready.body.truth).toBeUndefined();
    });

    it("404s an unknown case", async () => {
        const response = await request(app).get("/api/cases/2f1a2b3c-0000-4000-8000-000000000000");
        expect(response.status).toBe(404);
    });

    // A malformed id reaches a uuid column: a clean miss on sqlite, a 22P02
    // driver error (surfacing as a 500) on Postgres. The guard is what makes
    // both environments answer 404, so it needs an anchor here.
    it("404s a malformed case id instead of erroring", async () => {
        const response = await request(app).get("/api/cases/not-a-uuid");
        expect(response.status).toBe(404);
    });
});

describe("upload guards", () => {
    it("rejects a photo over the size cap with 400, not 500", async () => {
        const oversize = Buffer.alloc(9 * 1024 * 1024, 1);
        const response = await request(app)
            .post("/api/cases")
            .attach("photo", oversize, { filename: "big.png", contentType: "image/png" });

        expect(response.status).toBe(400);
    });

    it("rejects a disallowed mime type", async () => {
        const response = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.gif", contentType: "image/gif" });

        expect(response.status).toBe(400);
    });

    it("rejects more than one file", async () => {
        const response = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "a.png", contentType: "image/png" })
            .attach("photo", PNG_1X1, { filename: "b.png", contentType: "image/png" });

        expect(response.status).toBe(400);
    });
});

describe("env guards", () => {
    it("accepts a known APP_ENV", () => {
        expect(resolveAppEnv()).toBe("test");
    });

    it("throws on an unknown APP_ENV rather than defaulting to development", () => {
        const previous = process.env.APP_ENV;
        process.env.APP_ENV = "prod";
        try {
            expect(() => resolveAppEnv()).toThrow(/Unknown APP_ENV/);
        } finally {
            process.env.APP_ENV = previous;
        }
    });

    it("refuses an implicit APP_ENV when the deploy looks like production", () => {
        const previousEnv = process.env.APP_ENV;
        const previousUrl = process.env.DATABASE_URL;
        delete process.env.APP_ENV;
        process.env.DATABASE_URL = "postgresql://example/db";
        try {
            expect(() => assertAppEnvExplicit()).toThrow(/APP_ENV/);
        } finally {
            process.env.APP_ENV = previousEnv;
            if (previousUrl === undefined) {
                delete process.env.DATABASE_URL;
            } else {
                process.env.DATABASE_URL = previousUrl;
            }
        }
    });

    it("names a missing production secret instead of booting without it", () => {
        // packages/api/.env may populate these locally, so clear one explicitly
        // rather than assuming the environment is bare.
        const previous = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;
        try {
            expect(() => assertProductionEnv("production")).toThrow(/GEMINI_API_KEY/);
        } finally {
            if (previous === undefined) {
                delete process.env.GEMINI_API_KEY;
            } else {
                process.env.GEMINI_API_KEY = previous;
            }
        }
    });

    it("checks nothing outside production", () => {
        expect(() => assertProductionEnv("test")).not.toThrow();
    });

    // NaN does not throw, it silently disables the guard it is compared against:
    // `inFlight >= NaN` is false forever, so a typo'd ceiling removes the cap
    // instead of breaking loudly. Every one of these fails open.
    it("falls back to the default rather than returning NaN", () => {
        const previous = process.env.TEST_TUNABLE;
        try {
            process.env.TEST_TUNABLE = "three";
            expect(positiveIntEnv("TEST_TUNABLE", 3)).toBe(3);
            process.env.TEST_TUNABLE = "0";
            expect(positiveIntEnv("TEST_TUNABLE", 3)).toBe(3);
            process.env.TEST_TUNABLE = "-5";
            expect(positiveIntEnv("TEST_TUNABLE", 3)).toBe(3);
            process.env.TEST_TUNABLE = "";
            expect(positiveIntEnv("TEST_TUNABLE", 3)).toBe(3);
            process.env.TEST_TUNABLE = "7";
            expect(positiveIntEnv("TEST_TUNABLE", 3)).toBe(7);
        } finally {
            if (previous === undefined) {
                delete process.env.TEST_TUNABLE;
            } else {
                process.env.TEST_TUNABLE = previous;
            }
        }
    });
});
