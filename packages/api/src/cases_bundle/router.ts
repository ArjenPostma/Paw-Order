import { Router } from "express";
import type { RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { positiveIntEnv } from "@/config/env";
import {
    GenerationBusyError,
    createCase,
    findCaseStatus,
    generationSlotsAvailable,
} from "@/cases_bundle/services/case_service";
import { DEFAULT_DEFENDANT_NAME } from "@/cases_bundle/services/case_prompt";
import { playTurn } from "@/cases_bundle/services/trial_service";
import { dailyBudget, rateLimit } from "@/http/rate_limit";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/** Long enough for any dog's name, short enough that it cannot be a paragraph. */
const MAX_NAME_LENGTH = 32;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_REQUIRED = "A photo (jpeg, png or webp, max 8MB) is required.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- taking control characters out of a name is the point
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

// Memory storage: the photo goes straight to R2, it never touches local disk.
// fields/parts matter as much as fileSize - busboy defaults them to Infinity, so
// capping only the file leaves the multipart body as a whole unbounded (and
// express.json's limit never applies to multipart).
const upload = multer({
    storage: multer.memoryStorage(),
    // parts is one above the real part count, because busboy's counter rejects a
    // lone file part at parts:1. fields is what actually stops the "one tiny file
    // plus 100k text fields" body, files:1 the extra files. fields:1 is the
    // optional dog name and nothing else; busboy's own 1MB fieldSize default
    // bounds its length, and sanitiseName cuts it to MAX_NAME_LENGTH after that.
    // Not tightened here on purpose: a fieldSize violation is a MulterError, and
    // every MulterError answers "a photo is required", which an over-long name
    // is not.
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1, parts: 3, fields: 1 },
    fileFilter: (_req, file, callback) => {
        // Client-declared mime type is a hint, not proof - it caps the obvious
        // junk; the size limit is what actually bounds the request.
        callback(null, ALLOWED_MIME_TYPES.has(file.mimetype));
    },
});

/**
 * multer signals every limit violation through next(err), which skips the route
 * handler entirely and lands on the generic error handler as a 500. Translate
 * those to the 400 the caller can act on, and keep real errors flowing.
 */
const uploadPhoto: RequestHandler = (req, res, next) => {
    upload.single("photo")(req, res, (error: unknown) => {
        if (error instanceof MulterError) {
            res.status(400).json({ error: PHOTO_REQUIRED });
            return;
        }
        next(error);
    });
};

// Generation is anonymous and writes to paid storage, so it is capped per ip and
// per day. Both ceilings are env-tunable so a load test (or the suite) can raise
// them without editing code.
const perIpLimiter = rateLimit({
    windowMs: 60_000,
    max: positiveIntEnv("GENERATION_MAX_PER_MINUTE", 1),
});
const globalDailyBudget = dailyBudget({
    dailyMax: positiveIntEnv("GENERATION_MAX_PER_DAY", 50),
});

/**
 * Rejects a full server before multer buffers 8MB of body and before the daily
 * budget is charged, so back-pressure costs the operator nothing.
 */
const rejectWhenBusy: RequestHandler = (_req, res, next) => {
    if (!generationSlotsAvailable()) {
        res.setHeader("Retry-After", "60");
        res.status(503).json({ error: "The court is full. Try again in a minute." });
        return;
    }
    next();
};

/**
 * The one place the player's own words enter the generator, so it is the one
 * place they are cut down to size. Control characters go first: a newline would
 * otherwise let a "name" close the fence factsPrompt wraps it in and address the
 * model directly. Whitespace is collapsed so the cut at MAX_NAME_LENGTH cannot
 * land inside a run of spaces, and a name that is empty afterwards falls back to
 * the default rather than reaching the prompt as nothing.
 */
function sanitiseName(body: unknown): string {
    const value =
        typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
    if (typeof value !== "string") {
        return DEFAULT_DEFENDANT_NAME;
    }
    const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
    // Array.from splits by code point, not by UTF-16 unit: a plain slice can cut
    // a surrogate pair in half, and the lone half renders as U+FFFD on the arrest
    // sheet, in the courtroom caption and on the verdict line.
    const cut = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("").trim();
    return cut || DEFAULT_DEFENDANT_NAME;
}

/** Split out so the daily budget can be charged after it, never before. */
const requirePhoto: RequestHandler = (req, res, next) => {
    if (!req.file) {
        res.status(400).json({ error: PHOTO_REQUIRED });
        return;
    }
    next();
};

export const casesRouter = Router();

// Order is load-bearing, cheapest rejection first. The daily budget comes LAST
// because it is the ceiling that actually bounds the model bill: charging it
// before the body was parsed meant 50 photoless POSTs could burn the entire
// day's quota and lock out every real player for 24 hours at zero cost to the
// caller. A slot is now only ever spent on a request that is about to generate.
casesRouter.post(
    "/",
    perIpLimiter,
    rejectWhenBusy,
    uploadPhoto,
    requirePhoto,
    globalDailyBudget,
    async (req, res) => {
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: PHOTO_REQUIRED });
            return;
        }

        try {
            // 202, not 201: the case does not exist yet. Generation runs in the
            // background and the client polls GET /:id until it is READY.
            const accepted = await createCase(
                { bytes: file.buffer, mimeType: file.mimetype },
                // multer parses text fields onto req.body; anything else in
                // there is ignored, and an absent name is the default.
                sanitiseName(req.body),
            );
            res.status(202).json(accepted);
        } catch (error: unknown) {
            // rejectWhenBusy catches the common case; this is the lost race
            // between two requests that both saw a free slot.
            if (error instanceof GenerationBusyError) {
                res.setHeader("Retry-After", "60");
                res.status(503).json({ error: "The court is full. Try again in a minute." });
                return;
            }
            throw error;
        }
    },
);

/**
 * Pulls `path` out of an untrusted body without asserting anything about it.
 * replayRun does the real validation; this only avoids reading a property off
 * a null or a string.
 */
function pathFromBody(body: unknown): unknown {
    if (typeof body !== "object" || body === null || !("path" in body)) {
        return undefined;
    }
    return body.path;
}

/**
 * A turn spends no model budget and writes nothing, but it is not free: every
 * request is a full row read that deserialises the entire bible json column to
 * answer with one node, and it is uncacheable. Unlimited, that is enough
 * event-loop time to starve the generation path, whose final write would then
 * miss GENERATION_TIMEOUT_MS and fail a case with all five model calls already
 * paid for. 120 a minute is roughly twenty times a human's clicking rate.
 */
const perIpTurnLimiter = rateLimit({
    windowMs: 60_000,
    max: positiveIntEnv("TURN_MAX_PER_MINUTE", 120),
});

/** One turn of the trial. */
casesRouter.post("/:id/turn", perIpTurnLimiter, async (req, res) => {
    // A run is a live thing, unlike the case it is played against. Set before
    // the guards so every arm carries it, the 404 included.
    res.setHeader("Cache-Control", "no-store");

    // typeof, not a truthiness check: adding a middleware to this route widens
    // Express's inferred params to string | string[], and a repeated :id would
    // otherwise reach the pattern test as an array.
    const id = req.params.id;
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    // Shape-checked before the database read: a junk body should not cost a row
    // fetch and a full json parse. replayRun re-checks - this is the cheap out,
    // not the guard.
    const path = pathFromBody(req.body);
    if (!Array.isArray(path)) {
        res.status(400).json({ error: "That is not a run of this trial." });
        return;
    }

    const outcome = await playTurn(id, path);
    if (outcome === "NOT_PLAYABLE") {
        res.status(404).json({ error: "Case not found." });
        return;
    }
    if (outcome === "INVALID_PATH") {
        res.status(400).json({ error: "That is not a run of this trial." });
        return;
    }
    res.json(outcome);
});

casesRouter.get("/:id", async (req, res) => {
    const id = req.params.id;
    // The column is uuid on Postgres and varchar on sqlite: without this check a
    // malformed id is a clean miss in dev and a 22P02 driver error (surfacing as
    // a 500, plus a stack trace per crawler hit) in production.
    if (!id || !UUID_PATTERN.test(id)) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    const result = await findCaseStatus(id);
    if (!result) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    if (result.status === "READY") {
        // A generated case never changes, so a reload should not re-fetch it.
        // Only READY: caching a PENDING body for a year would freeze the poll
        // on "preparing" and the case would never appear.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
        res.setHeader("Cache-Control", "no-store");
    }
    res.json(result);
});
