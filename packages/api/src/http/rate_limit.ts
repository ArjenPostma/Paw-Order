import type { RequestHandler } from "express";

const DAY_MS = 24 * 60 * 60 * 1000;
// Hard cap on tracked ips: without it a spoofed-ip flood grows the map unbounded,
// which is the same memory-exhaustion the limiter exists to prevent.
const MAX_TRACKED_IPS = 10_000;

interface Bucket {
    count: number;
    startedAt: number;
}

export interface RateLimitOptions {
    /** Per-ip window length. */
    windowMs: number;
    /** Requests allowed per ip per window. */
    max: number;
}

/**
 * Fixed-window per-ip limiter.
 *
 * Deliberately separate from dailyBudget below. They were one middleware, which
 * meant the global ceiling was charged at the same point as the per-ip check -
 * before the body was parsed and before the request was known to be a real
 * upload. A caller could then spend the entire day's budget on requests that
 * generated nothing, locking every legitimate player out for 24 hours at zero
 * cost to themselves. Splitting them lets the cheap per-ip guard run first and
 * the expensive global one run only once a generation is actually going to
 * happen.
 *
 * ponytail: in-process state, so the ceilings are per replica and reset on
 * deploy. Correct while the api runs one replica (DEPLOY.md pins that); move to
 * a shared store (Postgres row or Redis) before scaling out.
 */
export function rateLimit({ windowMs, max }: RateLimitOptions): RequestHandler {
    const buckets = new Map<string, Bucket>();

    function prune(now: number): void {
        if (buckets.size < MAX_TRACKED_IPS) {
            return;
        }
        for (const [key, bucket] of buckets) {
            if (now - bucket.startedAt >= windowMs) {
                buckets.delete(key);
            }
        }
        // Still full: every tracked ip is inside its window, so the map is the
        // attack. Drop it wholesale rather than growing - the cost is that a
        // burst of distinct ips gets a fresh window.
        if (buckets.size >= MAX_TRACKED_IPS) {
            buckets.clear();
        }
    }

    return (req, res, next) => {
        const now = Date.now();
        prune(now);

        const key = req.ip ?? "unknown";
        const bucket = buckets.get(key);
        if (!bucket || now - bucket.startedAt >= windowMs) {
            buckets.set(key, { count: 1, startedAt: now });
        } else if (bucket.count >= max) {
            res.setHeader("Retry-After", Math.ceil((bucket.startedAt + windowMs - now) / 1000));
            res.status(429).json({ error: "Too many cases requested. Try again shortly." });
            return;
        } else {
            bucket.count += 1;
        }

        next();
    };
}

export interface DailyBudgetOptions {
    /** Process-wide ceiling per 24h, independent of ip - the backstop when the
     *  caller can rotate addresses. */
    dailyMax: number;
}

/**
 * Global 24h ceiling on how many cases this process will generate.
 *
 * Mount this LAST, after every check that can reject the request for free. It
 * is the ceiling that actually stands between an anonymous caller and the model
 * bill, so a slot must only ever be spent on a request that is about to
 * generate - never on a malformed body, a rejected upload, or a busy server.
 */
export function dailyBudget({ dailyMax }: DailyBudgetOptions): RequestHandler {
    let daily: Bucket = { count: 0, startedAt: Date.now() };

    return (_req, res, next) => {
        const now = Date.now();
        if (now - daily.startedAt >= DAY_MS) {
            daily = { count: 0, startedAt: now };
        }
        if (daily.count >= dailyMax) {
            res.status(429).json({ error: "The daily limit for new cases has been reached." });
            return;
        }

        daily.count += 1;
        next();
    };
}
