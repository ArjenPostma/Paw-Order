import { once } from "node:events";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { bucketKey, dailyBudget, rateLimit } from "@/http/rate_limit";
import type { RateLimitOptions } from "@/http/rate_limit";

/**
 * Real Express app rather than hand-built request/response fakes: the limiter
 * reads req.ip, which only means anything once Express has resolved it.
 * trust proxy lets each test present a distinct caller via X-Forwarded-For.
 */
function appWith(options: RateLimitOptions) {
    const app = express();
    app.set("trust proxy", true);
    app.get("/", rateLimit(options), (_req, res) => {
        res.json({ ok: true });
    });
    return app;
}

/**
 * A limited route whose handler rejects, so the refund path has something to
 * observe. `status` is what the handler answers once the limiter has passed it.
 *
 * The app emits "settled" once the refund for a request has actually run. The
 * refund happens on the response's finish event, and supertest resolves when the
 * CLIENT has the response, which is not ordered against the server firing that
 * event - so a test that fired its next request straight away could see a slot
 * the previous request had not given back yet, and read a 429 as a missing
 * refund. This listener is registered inside the handler, which is after the
 * limiter registered its own, and Node fires finish listeners in registration
 * order: by the time this one runs, the refund has.
 */
function appRejectingWith(options: RateLimitOptions, status: number) {
    const app = express();
    app.set("trust proxy", true);
    app.get("/", rateLimit(options), (_req, res) => {
        res.on("finish", () => app.emit("settled"));
        res.status(status).json({ error: "no" });
    });
    return app;
}

function get(app: express.Express, ip: string) {
    return request(app).get("/").set("X-Forwarded-For", ip);
}

describe("rateLimit", () => {
    it("allows up to max requests per ip, then 429s", async () => {
        const app = appWith({ windowMs: 60_000, max: 2 });

        expect((await get(app, "1.1.1.1")).status).toBe(200);
        expect((await get(app, "1.1.1.1")).status).toBe(200);

        const blocked = await get(app, "1.1.1.1");
        expect(blocked.status).toBe(429);
        expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("counts each ip separately", async () => {
        const app = appWith({ windowMs: 60_000, max: 1 });

        expect((await get(app, "1.1.1.1")).status).toBe(200);
        expect((await get(app, "1.1.1.1")).status).toBe(429);
        // A different caller is unaffected by the first one's spend.
        expect((await get(app, "2.2.2.2")).status).toBe(200);
    });

    it("uses the caller's own 429 message when given one", async () => {
        const app = appWith({ windowMs: 60_000, max: 1, message: "Come back tomorrow." });

        await get(app, "1.1.1.1");
        expect((await get(app, "1.1.1.1")).body.error).toBe("Come back tomorrow.");
    });

    // The ceilings that bound generation must only ever be spent on a request
    // that produced a case. Without the refund, being told no twice cost a
    // player both of their cases for the day and generated nothing.
    it("refunds the slot when the request is rejected downstream", async () => {
        // 503, not 429: the limiter's own rejection IS a 429, so a handler that
        // also answered 429 would make this pass whether or not the refund ran.
        const app = appRejectingWith({ windowMs: 60_000, max: 1, refundOnRejection: true }, 503);

        // Every one is refunded, so the single slot never runs out and the
        // limiter never gets to answer. A 429 here is the refund not happening.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            // Armed before the request, awaited after it: the refund is what the
            // next iteration depends on, and it lands after supertest resolves.
            const settled = once(app, "settled");
            expect((await get(app, "1.1.1.1")).status).toBe(503);
            await settled;
        }
    });

    it("keeps the slot when the request succeeds", async () => {
        const app = appWith({ windowMs: 60_000, max: 1, refundOnRejection: true });

        expect((await get(app, "1.1.1.1")).status).toBe(200);
        // A 200 is a case: the slot stays spent even with refunds enabled.
        expect((await get(app, "1.1.1.1")).status).toBe(429);
    });

    it("does not refund when refundOnRejection is off", async () => {
        const app = appRejectingWith({ windowMs: 60_000, max: 1 }, 400);

        // The rejection is exactly what an unrefunded limiter exists to bound:
        // this is the shape that guards the dog check's model call.
        expect((await get(app, "1.1.1.1")).status).toBe(400);
        expect((await get(app, "1.1.1.1")).status).toBe(429);
    });

    // The map is the limiter's own memory, and a caller who can pick their key
    // can grow it. Without the eviction below, a flood of distinct addresses is
    // the memory exhaustion the limiter is there to prevent.
    it("evicts rather than growing past maxTrackedIps", async () => {
        const app = appWith({ windowMs: 60_000, max: 1, maxTrackedIps: 2 });

        expect((await get(app, "1.1.1.1")).status).toBe(200);
        expect((await get(app, "1.1.1.1")).status).toBe(429);
        expect((await get(app, "2.2.2.2")).status).toBe(200);

        // Third distinct caller inside the same window: every bucket is live, so
        // pruning frees nothing and the map is dropped wholesale. The price of
        // that is exactly what the next line reads - the caller who was already
        // out of slots gets a fresh window. A 429 here means the map grew
        // instead.
        expect((await get(app, "3.3.3.3")).status).toBe(200);
        expect((await get(app, "1.1.1.1")).status).toBe(200);
    });

    // An IPv6 caller is handed a whole /64 and can send from any address in it,
    // so keying on the full address is keying on something the caller chooses.
    it("counts an IPv6 caller by their /64, not their address", async () => {
        const app = appWith({ windowMs: 60_000, max: 1 });

        expect((await get(app, "2001:db8:1:2::1")).status).toBe(200);
        // Same /64, address the caller picked for free. Same bucket.
        expect((await get(app, "2001:db8:1:2::99ff")).status).toBe(429);
        // A different /64 is a different caller.
        expect((await get(app, "2001:db8:1:3::1")).status).toBe(200);
    });
});

describe("bucketKey", () => {
    it("keeps an IPv4 address whole", () => {
        expect(bucketKey("203.0.113.7")).toBe("203.0.113.7");
    });

    // What Express hands back for an IPv4 client on a dual-stack socket. Read as
    // IPv6 and truncated to four hextets it becomes "0000:0000:0000:0000", which
    // files every IPv4 caller on earth in one bucket.
    it("reads an IPv4-mapped address as the IPv4 caller it is", () => {
        expect(bucketKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    });

    it("truncates an IPv6 address to its /64, expanding the zero run", () => {
        expect(bucketKey("2001:db8::1")).toBe("2001:0db8:0000:0000");
        expect(bucketKey("2001:db8::9999")).toBe("2001:0db8:0000:0000");
        expect(bucketKey("2001:0db8:0001:0002:0003:0004:0005:0006")).toBe("2001:0db8:0001:0002");
    });

    it("ignores a zone id, which is not part of the address", () => {
        expect(bucketKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000");
    });

    it("has a key for a caller Express could not resolve", () => {
        expect(bucketKey(undefined)).toBe("unknown");
    });
});

describe("dailyBudget", () => {
    function budgetApp(dailyMax: number) {
        const app = express();
        app.set("trust proxy", true);
        app.get("/", dailyBudget({ dailyMax }), (_req, res) => {
            res.json({ ok: true });
        });
        return app;
    }

    it("enforces the ceiling across every ip", async () => {
        const app = budgetApp(2);

        expect((await get(app, "1.1.1.1")).status).toBe(200);
        expect((await get(app, "2.2.2.2")).status).toBe(200);
        // Rotating addresses must not buy more than the global ceiling.
        expect((await get(app, "3.3.3.3")).status).toBe(429);
    });

    // The whole reason this is a separate middleware: it must be mountable
    // after the checks that reject for free, so a rejected request never spends
    // a slot of the day's model budget.
    it("only spends a slot on requests that reach it", async () => {
        const app = express();
        app.set("trust proxy", true);
        const budget = dailyBudget({ dailyMax: 1 });
        app.get(
            "/",
            (req, res, next) => {
                if (req.query.bad !== undefined) {
                    res.status(400).json({ error: "rejected before the budget" });
                    return;
                }
                next();
            },
            budget,
            (_req, res) => {
                res.json({ ok: true });
            },
        );

        // Three rejected requests ahead of the only real one.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            expect((await request(app).get("/?bad=1")).status).toBe(400);
        }
        expect((await request(app).get("/")).status).toBe(200);
        expect((await request(app).get("/")).status).toBe(429);
    });

    // Generation is accepted with a 202 and then runs in the background, so the
    // rejection refund cannot see it fail: by the time the failure is known the
    // response has finished and its status said yes. Without release, a model
    // outage spends the whole day's budget on generations that bought nothing.
    it("hands a slot back after the response has already gone out", async () => {
        const budget = dailyBudget({ dailyMax: 1 });
        const app = express();
        app.get("/", budget, (_req, res) => {
            res.status(202).json({ accepted: true });
        });

        expect((await request(app).get("/")).status).toBe(202);
        expect((await request(app).get("/")).status).toBe(429);

        budget.release();
        expect((await request(app).get("/")).status).toBe(202);
    });

    it("will not release a slot that was never charged", () => {
        const budget = dailyBudget({ dailyMax: 1 });
        const app = express();
        app.get("/", budget, (_req, res) => {
            res.status(202).json({ accepted: true });
        });

        // Releases with nothing outstanding must not lend the day a slot it
        // never spent - a background failure can outlive its own window.
        budget.release();
        budget.release();

        return request(app)
            .get("/")
            .expect(202)
            .then(() => request(app).get("/").expect(429));
    });
});
