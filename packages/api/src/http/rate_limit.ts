import type { RequestHandler } from "express";

const DAY_MS = 24 * 60 * 60 * 1000;
// Hard cap on tracked ips: without it a spoofed-ip flood grows the map unbounded,
// which is the same memory-exhaustion the limiter exists to prevent.
const DEFAULT_MAX_TRACKED_IPS = 10_000;
const TOO_MANY = "Too many cases requested. Try again shortly.";

interface Bucket {
    count: number;
    startedAt: number;
}

/**
 * What a caller is counted as.
 *
 * IPv4 is the address itself. IPv6 is the /64 the address sits in, because a
 * routed /64 is what an ordinary connection is handed: keyed on the full
 * address, one host rotates through 2^64 of them for free and every per-ip
 * ceiling here becomes no ceiling at all. The /64 is the smallest unit a caller
 * cannot pick for themselves.
 *
 * Two forms have to survive that: a zone id (`fe80::1%eth0`) is not part of the
 * address, and an IPv4-mapped address (`::ffff:203.0.113.7`, which is what
 * Express hands back for an IPv4 client on a dual-stack socket) is an IPv4
 * caller wearing IPv6 syntax - truncating it to four hextets would file every
 * IPv4 caller in the world under one bucket.
 */
export function bucketKey(rawIp: string | undefined): string {
    if (!rawIp) {
        return "unknown";
    }
    const [address = ""] = rawIp.split("%");
    if (!address.includes(":")) {
        return address;
    }
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped?.[1]) {
        return mapped[1];
    }

    const [head = "", tail] = address.split("::");
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === undefined || tail === "" ? [] : tail.split(":");
    const parts =
        tail === undefined
            ? headParts
            : [
                  ...headParts,
                  ...Array<string>(Math.max(0, 8 - headParts.length - tailParts.length)).fill("0"),
                  ...tailParts,
              ];
    return parts
        .slice(0, 4)
        .map((part) => part.toLowerCase().padStart(4, "0"))
        .join(":");
}

/**
 * A ceiling, either fixed or read per request.
 *
 * The env-backed ceilings pass a thunk. Read once at module load they were
 * pinned for the life of the process: a test could not lower one to observe
 * which middleware charged first without vi.resetModules, which rebuilds
 * AppDataSource. Reading per request also makes them tunable without a
 * redeploy.
 */
export type Ceiling = number | (() => number);

function resolveCeiling(value: Ceiling): number {
    return typeof value === "function" ? value() : value;
}

export interface RateLimitOptions {
    /** Per-ip window length. */
    windowMs: number;
    /** Requests allowed per ip per window. */
    max: Ceiling;
    /**
     * 429 body. The default says "shortly", which is only true of a window
     * measured in minutes - a day-long window needs its own wording.
     */
    message?: string;
    /**
     * How many ips to track before the backstop below evicts. Worth raising for
     * a long window: buckets only leave the map when their window expires, so a
     * 24h limiter accumulates every caller of the day and would otherwise hit
     * the backstop on ordinary traffic rather than under attack.
     */
    maxTrackedIps?: number;
    /**
     * Give the slot back when the request turns out not to have generated
     * anything (any 4xx or 5xx).
     *
     * Off by default, and deliberately NOT set on the limiters that guard work
     * done before the decision to generate - their whole job is to bound what a
     * rejected request already cost. On the ceilings that bound generation it is
     * the difference between "you have used one of your two cases today" and
     * "you were told no twice".
     */
    refundOnRejection?: boolean;
}

/**
 * Hands a charged slot back once the response is out, if the request produced
 * no case. Identity-checked against the bucket that was actually charged: a
 * window that rotated mid-request is a different bucket, and crediting this
 * request's rejection to it would let the next window start below zero.
 */
function refundWhenRejected(
    res: Parameters<RequestHandler>[1],
    charged: Bucket,
    live: () => Bucket | undefined,
): void {
    res.on("finish", () => {
        if (res.statusCode < 400) {
            return;
        }
        const current = live();
        if (current === charged && current.count > 0) {
            current.count -= 1;
        }
    });
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
export function rateLimit({
    windowMs,
    max,
    message = TOO_MANY,
    maxTrackedIps = DEFAULT_MAX_TRACKED_IPS,
    refundOnRejection = false,
}: RateLimitOptions): RequestHandler {
    const buckets = new Map<string, Bucket>();

    function prune(now: number): void {
        if (buckets.size < maxTrackedIps) {
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
        if (buckets.size >= maxTrackedIps) {
            buckets.clear();
        }
    }

    return (req, res, next) => {
        const now = Date.now();
        prune(now);

        const key = bucketKey(req.ip);
        const bucket = buckets.get(key);
        let charged: Bucket;
        if (!bucket || now - bucket.startedAt >= windowMs) {
            charged = { count: 1, startedAt: now };
            buckets.set(key, charged);
        } else if (bucket.count >= resolveCeiling(max)) {
            res.setHeader("Retry-After", Math.ceil((bucket.startedAt + windowMs - now) / 1000));
            res.status(429).json({ error: message });
            return;
        } else {
            bucket.count += 1;
            charged = bucket;
        }

        if (refundOnRejection) {
            refundWhenRejected(res, charged, () => buckets.get(key));
        }
        next();
    };
}

export interface DailyBudgetOptions {
    /** Process-wide ceiling per 24h, independent of ip - the backstop when the
     *  caller can rotate addresses. */
    dailyMax: Ceiling;
    /** 429 body, when the default is not what this ceiling means. */
    message?: string;
    /** See RateLimitOptions.refundOnRejection. */
    refundOnRejection?: boolean;
}

/**
 * A daily budget: the middleware that charges it, plus the way to hand a slot
 * back once the response has already gone out.
 */
export type DailyBudget = RequestHandler & {
    /**
     * Returns one charged slot. For work that is accepted with a 202 and then
     * fails in the background, which refundOnRejection cannot see: by the time
     * the failure is known the response is long finished and its status code
     * said yes.
     *
     * Not identity-checked against the bucket that was charged, unlike the
     * rejection refund: a background job can outlive the window it started in,
     * and refusing the refund then would be the wrong way round. The count > 0
     * guard is what keeps a late release from lending the new window a slot it
     * never spent.
     */
    release: () => void;
};

/**
 * Global 24h ceiling on how many cases this process will generate.
 *
 * Mount this LAST, after every check that can reject the request for free. It
 * is the ceiling that actually stands between an anonymous caller and the model
 * bill, so a slot must only ever be spent on a request that is about to
 * generate - never on a malformed body, a rejected upload, or a busy server.
 */
export function dailyBudget({
    dailyMax,
    // Says what the player can do next, not which ceiling they met: from the
    // envelope, "the model budget is spent" and "the dog check is spent" are one
    // outcome, and the cases already on file are the way out of both. The upload
    // screen renders this directly above those strips.
    message = "The court is closed to new cases today. The cases below are still open.",
    refundOnRejection = false,
}: DailyBudgetOptions): DailyBudget {
    let daily: Bucket = { count: 0, startedAt: Date.now() };

    const middleware: RequestHandler = (_req, res, next) => {
        const now = Date.now();
        if (now - daily.startedAt >= DAY_MS) {
            daily = { count: 0, startedAt: now };
        }
        if (daily.count >= resolveCeiling(dailyMax)) {
            res.status(429).json({ error: message });
            return;
        }

        daily.count += 1;
        const charged = daily;
        if (refundOnRejection) {
            refundWhenRejected(res, charged, () => daily);
        }
        next();
    };

    return Object.assign(middleware, {
        release: (): void => {
            if (daily.count > 0) {
                daily.count -= 1;
            }
        },
    });
}
