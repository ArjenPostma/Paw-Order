import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { dailyBudget, rateLimit } from "@/http/rate_limit";
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
});
