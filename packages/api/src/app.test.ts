import "reflect-metadata";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { assertAppEnvExplicit, assertProductionEnv, resolveAppEnv } from "@/config/env";
import { AppDataSource } from "@/database_bundle/util/data_source";

// Smallest valid PNG (1x1, transparent).
const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

const app = createApp();

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

    it("persists an uploaded case and serves it back without the hidden truth", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        expect(created.status).toBe(201);
        expect(created.body.id).toBeTruthy();
        expect(created.body.truth).toBeUndefined();

        const fetched = await request(app).get(`/api/cases/${created.body.id}`);
        expect(fetched.status).toBe(200);
        expect(fetched.body.id).toBe(created.body.id);
        expect(fetched.body.truth).toBeUndefined();
        // Tests must never write to the real bucket, whatever packages/api/.env holds.
        expect(fetched.body.defendant.photoUrl).toContain("data:image/png");
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
});
