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
import { CaseEntity } from "@/cases_bundle/models/case_entity";
import { generationSlotsInUse } from "@/cases_bundle/services/case_service";

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
        // The whole tree no longer ships: only the node the player is on. The
        // rest arrives one turn at a time from POST /:id/turn.
        expect(fetched.body.rootNode.id).toBeTruthy();
        expect(fetched.body.rootNode.choices.length).toBeGreaterThan(0);
        expect(fetched.body.nodes).toBeUndefined();
        expect(fetched.body.rootNodeId).toBeUndefined();
        expect(fetched.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        // Tests must never write to the real bucket, whatever packages/api/.env holds.
        expect(fetched.body.defendant.photoUrl).toContain("data:image/png");
    });

    // Two truth-derived fields that are NOT called `truth`. `reliable` names the
    // witness who is lying, which gamedesign.md section 8 lists as one of the
    // hidden truths; `imagePrompt` is prose from the same model call that wrote
    // the truth. Both shipped before this anchor existed.
    it("strips every truth-derived field from a READY case, not just truth", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        const ready = await pollUntilReady(created.body.id);
        expect(ready.body.witnesses.length).toBeGreaterThan(0);
        for (const witness of ready.body.witnesses) {
            expect(witness.claim).toBeTruthy();
            expect(witness.reliable).toBeUndefined();
        }
        expect(ready.body.evidence.length).toBeGreaterThan(0);
        for (const exhibit of ready.body.evidence) {
            expect(exhibit.visualFacts.length).toBeGreaterThan(0);
            expect(exhibit.imagePrompt).toBeUndefined();
        }
    });

    // The reason this endpoint shape exists. effects is the doubt/credibility/
    // suspicion table: with it on the wire a player sorts by effects.doubt and
    // walks the optimal path without reading a word (gamedesign.md section 7),
    // and nextNodeId hands them the map to do it with. Asserting on the
    // serialized body rather than named fields is deliberate - it fails wherever
    // in the payload a regression reintroduces them.
    it("never ships the effects table, the tree edges or the thresholds", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        const ready = await pollUntilReady(created.body.id);
        // Asserted BEFORE the absence checks. Four of the five assertions below
        // are negative, and a negative passes on an empty body, an error body,
        // or a case that shipped no choices at all - so without this the test
        // stays green while the courtroom is unplayable.
        expect(ready.body.status).toBe("READY");
        expect(ready.body.rootNode.choices.length).toBeGreaterThan(0);

        const wire = JSON.stringify(ready.body);
        // Under these names. The load-bearing check is the key-set assertion
        // below; these catch a reintroduction anywhere in the payload, but not
        // a rename.
        expect(wire).not.toContain("effects");
        expect(wire).not.toContain("nextNodeId");
        expect(wire).not.toContain("acquitAtDoubt");
        expect(wire).not.toContain("suspiciousAtSuspicion");
        expect(ready.body.verdictRules).toBeUndefined();
        for (const choice of ready.body.rootNode.choices) {
            expect(choice.text).toBeTruthy();
            expect(Object.keys(choice)).toEqual(["text"]);
        }
    });

    // The reveal mechanic only means something if the exhibits are not all
    // handed over at the door. E3's clock reads 14:22 and W1 claims 14:30, so
    // shipping every exhibit up front let a player identify the lying witness
    // before answering a single question (gamedesign.md 8).
    it("ships only the exhibits the opening statement puts in play", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        const ready = await pollUntilReady(created.body.id);
        expect(ready.body.evidence.map((exhibit: { id: string }) => exhibit.id)).toEqual(["E1"]);
        expect(JSON.stringify(ready.body)).not.toContain("14:22");
    });

    // The FAILED arm had no anchor at all, so a regression that served the bible
    // on failure would have shipped silently.
    it("serves no case body when generation failed", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });
        await pollUntilReady(created.body.id);

        // Drive the row to FAILED directly: the test generator always succeeds,
        // so this status is otherwise unreachable from the suite.
        await AppDataSource.getRepository(CaseEntity).update(created.body.id, { status: "FAILED" });

        const failed = await request(app).get(`/api/cases/${created.body.id}`);
        expect(failed.status).toBe(200);
        expect(failed.body.status).toBe("FAILED");
        expect(failed.body.truth).toBeUndefined();
        expect(failed.body.nodes).toBeUndefined();
        expect(failed.body.evidence).toBeUndefined();
        expect(failed.body.witnesses).toBeUndefined();
        expect(failed.body.defendant).toBeUndefined();
        expect(failed.headers["cache-control"]).toBe("no-store");
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

/**
 * The trial itself. State is never accepted from the client: the run is the
 * list of choice indexes taken so far, replayed server-side from the root every
 * turn, so there is nothing to forge. The fixture tree is the one being played
 * here - N1 choice 1 asks about the photograph and reveals the clock (E3).
 */
describe("trial turns", () => {
    async function readyCase(): Promise<string> {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });
        await pollUntilReady(created.body.id);
        const id: string = created.body.id;
        return id;
    }

    it("answers an empty path with the opening node", async () => {
        const id = await readyCase();
        const turn = await request(app).post(`/api/cases/${id}/turn`).send({ path: [] });

        expect(turn.status).toBe(200);
        expect(turn.body.status).toBe("NODE");
        expect(turn.body.node.id).toBe("N1");
        // The opening node cites E1, so that exhibit is in play from the start;
        // nothing else is until a choice unlocks it.
        expect(turn.body.evidence.map((exhibit: { id: string }) => exhibit.id)).toEqual(["E1"]);
        expect(turn.headers["cache-control"]).toBe("no-store");
    });

    it("advances a turn and reports what the choice revealed", async () => {
        const id = await readyCase();
        const turn = await request(app)
            .post(`/api/cases/${id}/turn`)
            .send({ path: [1] });

        expect(turn.status).toBe(200);
        expect(turn.body.status).toBe("NODE");
        expect(turn.body.node.id).toBe("N3");
        expect(turn.body.node.statement).toBeTruthy();
        // E1 was in play from the opening node, E3 is what this choice unlocked.
        expect(turn.body.evidence.map((exhibit: { id: string }) => exhibit.id).sort()).toEqual([
            "E1",
            "E3",
        ]);
        // Mid-trial the player sees the courtroom, not the scoreboard.
        expect(turn.body.verdict).toBeUndefined();
        expect(turn.body.score).toBeUndefined();
        expect(turn.body.truth).toBeUndefined();
        expect(turn.body.doubt).toBeUndefined();
    });

    it("ends the run with a verdict, a score and the truth", async () => {
        const id = await readyCase();
        // The doubt-maximal run: 55 of 55 doubt, 20 of 30 credibility.
        const turn = await request(app)
            .post(`/api/cases/${id}/turn`)
            .send({ path: [1, 0, 0, 1] });

        expect(turn.status).toBe(200);
        expect(turn.body.status).toBe("VERDICT");
        // 55 doubt against an acquitAtDoubt of 60: the fixture cannot be won,
        // and still scores 95 for taking every point it offers.
        expect(turn.body.verdict).toBe("GUILTY_BUT_REASONABLE_DOUBT");
        expect(turn.body.score).toBe(95);
        expect(turn.body.truth.summary).toBeTruthy();
        expect(turn.body.node).toBeUndefined();
    });

    it("scores a short concession well below a fought run", async () => {
        const id = await readyCase();
        const turn = await request(app)
            .post(`/api/cases/${id}/turn`)
            .send({ path: [1, 1] });

        expect(turn.body.status).toBe("VERDICT");
        expect(turn.body.verdict).toBe("GUILTY");
        expect(turn.body.score).toBe(20);
    });

    it("keeps the effects table off the wire mid-trial too", async () => {
        const id = await readyCase();
        const turn = await request(app)
            .post(`/api/cases/${id}/turn`)
            .send({ path: [1] });

        const wire = JSON.stringify(turn.body);
        expect(wire).not.toContain("effects");
        expect(wire).not.toContain("nextNodeId");
        // misleadingEvidenceIds is the one key that exists only inside Truth, so
        // it catches a nested leak that `body.truth` being undefined would not -
        // e.g. a debug field, or truth folded into the node.
        expect(wire).not.toContain("misleadingEvidenceIds");
        expect(turn.body.truth).toBeUndefined();
        // The exact field set publicNode is supposed to produce. speaker and
        // evidenceIds were asserted nowhere before this, so dropping either
        // from that hand-listed block left every test green and the courtroom
        // rendering "undefined:" at the player.
        expect(Object.keys(turn.body.node).sort()).toEqual([
            "choices",
            "evidenceIds",
            "id",
            "speaker",
            "statement",
        ]);
        for (const choice of turn.body.node.choices) {
            expect(Object.keys(choice)).toEqual(["text"]);
        }
    });

    it("answers a malformed json body with 400 rather than 500", async () => {
        const id = await readyCase();
        const turn = await request(app)
            .post(`/api/cases/${id}/turn`)
            .set("Content-Type", "application/json")
            .send('{"path":[');

        expect(turn.status).toBe(400);
        expect(turn.body.error).toBeTruthy();
    });

    // Every one of these is a body an anonymous caller can post.
    it("rejects a path that does not resolve", async () => {
        const id = await readyCase();
        for (const path of [
            [9],
            [1, 1, 0],
            [-1],
            [1.5],
            ["length"],
            ["0"],
            [null],
            [{}],
            Array.from({ length: 100 }, () => 0),
        ]) {
            const turn = await request(app).post(`/api/cases/${id}/turn`).send({ path });
            expect(turn.status).toBe(400);
        }
    });

    it("rejects a body whose path is not an array", async () => {
        const id = await readyCase();
        for (const body of [{}, { path: "1" }, { path: 1 }, { path: null }]) {
            const turn = await request(app).post(`/api/cases/${id}/turn`).send(body);
            expect(turn.status).toBe(400);
        }
    });

    it("404s a turn against a case that is not playable", async () => {
        const unknown = await request(app)
            .post("/api/cases/2f1a2b3c-0000-4000-8000-000000000000/turn")
            .send({ path: [] });
        expect(unknown.status).toBe(404);

        const malformed = await request(app).post("/api/cases/not-a-uuid/turn").send({ path: [] });
        expect(malformed.status).toBe(404);

        const id = await readyCase();
        await AppDataSource.getRepository(CaseEntity).update(id, { status: "FAILED" });
        const failed = await request(app).post(`/api/cases/${id}/turn`).send({ path: [] });
        expect(failed.status).toBe(404);
    });
});

// The slot counter is what bounds concurrent model spend, and a leak is
// invisible over HTTP until the api starts 503ing everything. Asserting it
// returns to zero is the cheapest anchor that fails if a release path is lost.
describe("generation slot accounting", () => {
    it("releases the slot once generation settles", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });
        await pollUntilReady(created.body.id);

        // The release happens in runGeneration's finally, which runs after the
        // status update the poll observed.
        for (let attempt = 0; attempt < 50 && generationSlotsInUse() > 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(generationSlotsInUse()).toBe(0);
    });

    it("rejects a request with no photo before charging the daily budget", async () => {
        // The 400 must come from requirePhoto, which sits BEFORE the budget
        // middleware. If the order is ever reversed, photoless requests start
        // spending the day's generation quota and this test still passes - so
        // the ordering comment in router.ts carries the rest of the weight.
        const response = await request(app).post("/api/cases");
        expect(response.status).toBe(400);
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
