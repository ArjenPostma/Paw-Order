import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";
import { positiveIntEnv } from "@/config/env";
import {
    GenerationBusyError,
    createCase,
    findCaseStatus,
    findPublicCaseBySlug,
    findReusableCase,
    generationSlotsAvailable,
    listPublicCases,
    unpublishCase,
} from "@/cases_bundle/services/case_service";
import type { PhotoScreening } from "@/cases_bundle/services/case_generator";
import { DogCheckBusyError, screenPhoto } from "@/cases_bundle/services/case_generator";
import { DEFAULT_DEFENDANT_NAME } from "@/cases_bundle/services/case_prompt";
import { playTurn } from "@/cases_bundle/services/trial_service";
import { dailyBudget, rateLimit } from "@/http/rate_limit";

// Declaration merging rather than a cast onto the request: reuseExistingCase
// already hashed the photo and the route handler needs that digest to store on
// the row, and hashing 8MB a second time to avoid one interface is the wrong
// saving.
declare module "express-serve-static-core" {
    interface Request {
        /** Set by reuseExistingCase when the photo turned out to be new. */
        photoHash?: string;
    }
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Long enough for any dog's name, short enough that it cannot be a paragraph. */
const MAX_NAME_LENGTH = 32;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_REQUIRED = "A photo (jpeg, png or webp, max 8MB) is required.";
const NOT_A_DOG = "This court only tries dogs. Try a photo of one.";
const NOT_PUBLISHABLE =
    "This photo cannot be entered into the public record. Untick the box to try this case privately.";
const OBSCENE_NAME = "The court will not read that name aloud. Try the one the dog answers to.";
const NOT_HUMAN = "The bailiff wants to see some ID. Reload the page and try again.";
/**
 * How long the page must have been open before an upload is believable. A person
 * has to read the screen and pick a file; two seconds is under the fastest that
 * can happen and well over any real render delay.
 */
const MIN_DWELL_MS = 2_000;
const URL_NAME = "That is a web address, not a name.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// C0, DEL and C1, plus the invisible formatting characters. The formatting ones
// are not control characters and not \s, so without them here a name of 32 zero
// width spaces counts as filled, the "The dog" fallback never fires, and the
// defendant renders as nothing at all on the arrest sheet, the caption, the
// verdict line and the tile placard. U+202E does worse: it reverses the text
// around it on all four.
/* eslint-disable no-control-regex -- taking control characters out of a name is the point */
const CONTROL_CHARACTERS =
    /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/* eslint-enable no-control-regex */

// Memory storage: the photo goes straight to R2, it never touches local disk.
// fields/parts matter as much as fileSize - busboy defaults them to Infinity, so
// capping only the file leaves the multipart body as a whole unbounded (and
// express.json's limit never applies to multipart).
const upload = multer({
    storage: multer.memoryStorage(),
    // parts is one above the real part count, because busboy's counter rejects a
    // lone file part at parts:1. fields is what actually stops the "one tiny file
    // plus 100k text fields" body, files:1 the extra files. fields:2 is the
    // optional dog name and the public-record checkbox, and nothing else;
    // busboy's own 1MB fieldSize default bounds their length, and sanitiseName
    // cuts the name to MAX_NAME_LENGTH after that. Not tightened here on purpose:
    // a fieldSize violation is a MulterError, and every MulterError answers "a
    // photo is required", which an over-long name is not.
    //
    // Both counts are exact, so they are load-bearing in the other direction
    // too: leaving fields at 1 when the checkbox was added would have made every
    // upload that carried a name AND a checkbox a MulterError, answered "A photo
    // is required" for a request that had one. fields:4 is the name, the
    // checkbox, and the two requireHuman carries - the honeypot and the dwell.
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1, parts: 6, fields: 4 },
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
// per day. Every ceiling is env-tunable so a load test (or the suite) can raise
// it without editing code, and every one is passed as a thunk so the env value
// is read per request rather than pinned at module load - which is what lets a
// test lower one mid-suite to check which middleware charged first, and what
// makes a ceiling changeable without a redeploy.

/**
 * The outer per-ip bound, and the only one mounted before the body is read. It
 * is deliberately loose: what it exists to cap is the work done on the way to
 * deciding whether to generate at all - buffering up to 8MB of multipart, and
 * the dog check's model call - not generation itself, which the tighter limiter
 * below owns.
 *
 * Loose enough that no honest player meets it. Someone picking the wrong photo
 * two or three times in a row is the normal case this exists to let through.
 */
const perIpUploadLimiter = rateLimit({
    windowMs: 60_000,
    max: () => positiveIntEnv("UPLOAD_MAX_PER_MINUTE", 10),
});
/**
 * The real per-ip ceiling on generation, mounted past every check that can turn
 * a request away without generating anything.
 *
 * Split out of perIpUploadLimiter for the same reason dailyBudget was split out
 * of rateLimit: charged at the door, it was spent on requests that generated
 * nothing. A photo with no dog in it, or one whose case already exists, would
 * take the player's minute and answer the next upload - the one that was going
 * to work - with 429, having produced no case for it.
 */
const perIpGenerationLimiter = rateLimit({
    windowMs: 60_000,
    max: () => positiveIntEnv("GENERATION_MAX_PER_MINUTE", 1),
    refundOnRejection: true,
});
/**
 * The second ceiling on the same ip, over a 24h window rather than a minute.
 * The per-minute limiter stops a burst; this is what stops one caller walking
 * steadily through the whole day's budget at one case a minute.
 *
 * Only new cases are capped. Replaying costs no generation and does not come
 * through this route at all, so a player who has spent both still has every
 * case they have ever played.
 *
 * ponytail: shares rate_limit.ts's in-process state, so it resets on deploy -
 * and its MAX_TRACKED_IPS backstop clears the whole map wholesale, which over a
 * 24h window means 10k distinct ips resets everyone's daily allowance. The
 * global budget below is the ceiling that still holds in that case.
 */
const perIpDailyLimiter = rateLimit({
    windowMs: DAY_MS,
    max: () => positiveIntEnv("GENERATION_MAX_PER_IP_PER_DAY", 2),
    // The default 429 body says "shortly", which is a lie about a 24h window.
    message: "That is both of today's cases. A new one can be opened tomorrow.",
    // Buckets only leave the map when their window expires, so over a day this
    // one accumulates every caller rather than every recent caller. At the
    // default 10k the backstop would clear wholesale on an ordinary traffic day
    // and hand everyone a fresh allowance.
    maxTrackedIps: 200_000,
    refundOnRejection: true,
});
/**
 * The global ceiling on the dog check specifically.
 *
 * The check is a paid model call sitting in front of every generation ceiling,
 * which is the point - a photo with no dog in it must not cost the player a
 * case. But that also puts it outside globalDailyBudget, and without a ceiling
 * of its own it was the one thing in the app that could spend money with no
 * 24h bound at all: 10 uploads a minute is 14,400 billed calls a day from one
 * address, and rotating addresses multiplied it linearly.
 *
 * Set well above the generation budget, because rejecting non-dogs is the
 * cheap outcome and should not be the scarce one.
 */
const dogCheckBudget = dailyBudget({
    dailyMax: () => positiveIntEnv("DOG_CHECK_MAX_PER_DAY", 200),
    message: "The court has closed its doors for today. Try again tomorrow.",
    // Deliberately NOT refunded: the 400 this guards IS the spend it bounds.
});
const globalDailyBudget = dailyBudget({
    dailyMax: () => positiveIntEnv("GENERATION_MAX_PER_DAY", 50),
    refundOnRejection: true,
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
 * place they are cut down to size. Control and formatting characters go first,
 * so what reaches the prompt is a line of visible text rather than something
 * that only looks like one. Whitespace is collapsed so the cut at
 * MAX_NAME_LENGTH cannot land inside a run of spaces, and a name that is empty
 * afterwards falls back to the default rather than reaching the prompt as
 * nothing. factsPrompt then JSON-quotes whatever survives.
 */
function sanitiseName(body: unknown): string {
    const value =
        typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
    if (typeof value !== "string") {
        return DEFAULT_DEFENDANT_NAME;
    }
    // Cut to a bounded prefix FIRST. busboy's own fieldSize default lets this
    // arrive as 1MB of text, and rewriting all of it twice and then exploding it
    // into a per-code-point array to keep 32 characters is ~10MB of garbage per
    // request. A code point is at most two UTF-16 units, so twice the budget
    // cannot drop any of the first MAX_NAME_LENGTH of them.
    const cleaned = value
        .slice(0, MAX_NAME_LENGTH * 2)
        .replace(CONTROL_CHARACTERS, " ")
        .replace(/\s+/g, " ")
        .trim();
    // Array.from splits by code point, not by UTF-16 unit: a plain slice can cut
    // a surrogate pair in half, and the lone half renders as U+FFFD on the arrest
    // sheet, in the courtroom caption and on the verdict line.
    const cut = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("").trim();
    return cut || DEFAULT_DEFENDANT_NAME;
}

/**
 * Whether the player ticked "Enter into the public record".
 *
 * multipart carries no booleans - the field arrives as a string or not at all -
 * and the client omits it entirely when the box is clear. Only the exact string
 * counts: publishing a player's dog is not something to infer from "1", "on" or
 * a field that happens to be present, and an absent field is the safe default
 * either way.
 */
function wantsPublicRecord(body: unknown): boolean {
    return typeof body === "object" && body !== null && "public" in body && body.public === "true";
}

// The player's name for their dog is written through the whole bible - the
// charge, the timeline, every witness claim - and it is the one string of theirs
// the game reads back to them on five screens. Two things it may not be.
//
// englishRecommendedTransformers is why the dependency is here rather than a
// wordlist: it folds leetspeak, confusable characters and repeated letters back
// to the dataset's terms, so the obvious evasions of a flat list do not work.
// It is English only, and it will turn away a dog genuinely called Dick. Both
// are accepted: a false reject costs one retype on the first screen.
const obsceneName = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
});

/**
 * "f u c k e r" is eleven characters of nothing to the matcher, so the spaced
 * spelling is squashed and checked as well.
 *
 * Only runs between SINGLE letters, which is the whole point. obscenity ships
 * skipNonAlphabeticTransformer for this, and it joins across every space: with
 * it, "Anna Nussbaum", "Bob Itchy" and "Bo Oberon" are all turned away, because
 * the whitelist matches the untransformed string and never sees the joined
 * form. Turning away a real dog is worse than missing an evasion, and the
 * evasions this does miss ("f1u1c1k") arrive garbled anyway.
 */
function squashSpacedLetters(name: string): string {
    return name.replace(/\b(\w)[\s._-]+(?=\w\b)/g, "$1");
}
// Deliberately not a general "word dot word" pattern: that also matches
// "St.Bernard". A scheme, a www, or a known TLD is what a name being used as an
// advertisement actually looks like.
const URL_NAME_PATTERN =
    /:\/\/|\bwww\.|\.(com|net|org|io|co|dev|app|xyz|me|ru|info|biz|shop|top|link|site|online|store|tv|ai|gg|nl|uk|de)\b/i;

/**
 * Turns away a name the court cannot say out loud, and one that is really a
 * link. Sanitised first, so the check reads the same string the generator will:
 * a name spelled with control characters between its letters must not slip past
 * a check that ran before they were stripped.
 *
 * Mounted ahead of the dog check and every ceiling, because rejecting it costs
 * nothing - and ahead of reuseExistingCase, so a name banned today cannot be
 * replayed through a case generated for it yesterday.
 */
const requireCleanName: RequestHandler = (req, res, next) => {
    const name = sanitiseName(req.body);
    if (URL_NAME_PATTERN.test(name)) {
        res.status(400).json({ error: URL_NAME });
        return;
    }
    if (obsceneName.hasMatch(name) || obsceneName.hasMatch(squashSpacedLetters(name))) {
        res.status(400).json({ error: OBSCENE_NAME });
        return;
    }
    next();
};

/** Split out so the daily budget can be charged after it, never before. */
const requirePhoto: RequestHandler = (req, res, next) => {
    if (!req.file) {
        res.status(400).json({ error: PHOTO_REQUIRED });
        return;
    }
    next();
};

/**
 * The two fields requireHuman reads, pulled off an untrusted body without
 * asserting anything about them. multer parses text fields onto req.body as
 * strings, but nothing guarantees the caller sent either one.
 */
function formTraps(body: unknown): { website: unknown; dwell: unknown } {
    if (typeof body !== "object" || body === null) {
        return { website: undefined, dwell: undefined };
    }
    return {
        website: "website" in body ? body.website : undefined,
        dwell: "dwell" in body ? body.dwell : undefined,
    };
}

/**
 * The cheap bot filter, and the only check on this route no real player ever
 * meets.
 *
 * Two signals, both from the form. `website` is a field the upload screen hides
 * from people and leaves for anything that fills inputs by name - a person never
 * sees it, so anything in it is not one. `dwell` is milliseconds from page load
 * to submit, which a person cannot get under MIN_DWELL_MS because they have to
 * pick a file first. Absent counts as failed: a script posting straight at the
 * route sends neither, which is exactly the caller this turns away.
 *
 * Mounted after requirePhoto and before every ceiling, so a bot is refused
 * without spending a slot, a dog check or a case.
 *
 * ponytail: both values come from the caller, so this is a speed bump and not a
 * bound on the bill - the ceilings above are what actually bound it. Anything
 * driving a real browser walks straight through. Cloudflare Turnstile is the
 * upgrade if one ever bothers.
 */
const requireHuman: RequestHandler = (req, res, next) => {
    const { website, dwell } = formTraps(req.body);
    const trapped = typeof website === "string" && website.trim() !== "";
    // Not Number.parseInt: that reads "2000abc" as 2000, and a value that is not
    // a number is a caller that did not fill this in from the page.
    const openFor = typeof dwell === "string" ? Number(dwell) : Number.NaN;
    if (trapped || !Number.isFinite(openFor) || openFor < MIN_DWELL_MS) {
        res.status(400).json({ error: NOT_HUMAN });
        return;
    }
    next();
};

/**
 * Hands back the case already generated for these exact bytes under this exact
 * name, rather than paying for a second one.
 *
 * Mounted ahead of the dog check and both daily ceilings on purpose: a reuse
 * generates nothing, so it must not spend a model call or a slot from either.
 * That also means re-uploading a photo you have already played never costs you
 * one of your two cases for the day.
 *
 * The name goes into the digest because the prompts write it through the whole
 * bible, so the same dog under a new name is a different case rather than a
 * relabelled one. sanitiseName runs first for the same reason the route uses it:
 * two names that reach the generator identically must hash identically.
 */
const reuseExistingCase: RequestHandler = async (req, res, next) => {
    const file = req.file;
    if (!file) {
        next();
        return;
    }

    // The NUL separator is what stops ("ab", "c") and ("a", "bc") colliding.
    // sanitiseName has already stripped control characters, so no name can
    // contain one.
    const photoHash = createHash("sha256")
        .update(file.buffer)
        .update("\0")
        .update(sanitiseName(req.body))
        .digest("hex");

    const existing = await findReusableCase(photoHash);
    if (existing) {
        // 200, not 202: nothing was accepted for generation. The client polls
        // on either, so a PENDING hit joins the run already going.
        //
        // Not a guarantee against double-submits: this read and the insert that
        // follows are not atomic and the index is deliberately non-unique, so
        // two requests that overlap can both miss and both generate. What
        // actually serialises them is perIpGenerationLimiter at one a minute.
        res.status(200).json(existing);
        return;
    }

    req.photoHash = photoHash;
    next();
};

/**
 * Turns away a photo with no dog in it before anything is paid for, and a photo
 * that cannot be shown in public when the player asked for the public record.
 *
 * Ahead of both daily ceilings, so a rejected photo spends neither. Behind
 * reuseExistingCase, so a photo already tried in this court is never asked
 * about twice.
 *
 * Its own cost is bounded by the per-minute limiter above and nothing else -
 * one text call per upload attempt, against ~$0.11 for the generation it stands
 * in front of.
 *
 * The safety half is only consulted when the tick box is set. A private case is
 * seen by the person who uploaded the photo and nobody else, so screening it
 * would be refusing someone their own picture; the docket is what has an
 * audience, and the docket is what this guards. It is the gate on publication
 * going up - takedown (DELETE /link/:slug) is the one for what got through.
 */
const requireDog: RequestHandler = async (req, res, next) => {
    const file = req.file;
    if (!file) {
        next();
        return;
    }

    let screening: PhotoScreening;
    try {
        screening = await screenPhoto({ bytes: file.buffer, mimeType: file.mimetype });
    } catch (error: unknown) {
        // Every check holds the photo and its base64 copy alive while it runs,
        // so the slots are a memory bound, not a cost one. Shedding here is the
        // right answer: the alternative is queueing 8MB buffers behind it.
        if (error instanceof DogCheckBusyError) {
            res.setHeader("Retry-After", "60");
            res.status(503).json({ error: "The court is full. Try again in a minute." });
            return;
        }
        throw error;
    }

    if (!screening.isDog) {
        res.status(400).json({ error: NOT_A_DOG });
        return;
    }

    if (wantsPublicRecord(req.body) && !screening.safeForPublic) {
        res.status(400).json({ error: NOT_PUBLISHABLE });
        return;
    }

    next();
};

export const casesRouter = Router();

// Order is load-bearing, cheapest rejection first, and every ceiling that
// bounds generation sits behind every check that can turn the request away
// without generating anything. A slot - per minute, per day, or global - is
// only ever spent on a request that is about to produce a case.
//
// Both times that rule was broken it cost the player rather than the attacker.
// The daily budget, charged before the body was parsed, let 50 photoless POSTs
// burn the whole day's quota and lock out every real player for 24 hours at no
// cost to the caller. The per-minute limiter, charged at the door, took the
// player's minute for a photo with no dog in it or one whose case already
// existed, and then answered the upload that WOULD have worked with a 429.
//
// perIpUploadLimiter and dogCheckBudget are the exceptions, and only because
// they guard the work that happens before that decision can be made: the
// multipart buffer and the dog check's model call. Neither is refunded on a
// rejection - the rejected request is exactly what they exist to bound - and
// every ceiling behind them is, so being told no never costs a case.
//
// rejectWhenBusy sits behind reuseExistingCase rather than in front of it: a
// reuse generates nothing and needs no slot, so answering it with "the court is
// full" turned a free hit into a failure. The cost is that the multipart body is
// buffered before the 503, which perIpUploadLimiter bounds.
casesRouter.post(
    "/",
    perIpUploadLimiter,
    uploadPhoto,
    requirePhoto,
    requireHuman,
    requireCleanName,
    reuseExistingCase,
    rejectWhenBusy,
    dogCheckBudget,
    requireDog,
    perIpGenerationLimiter,
    perIpDailyLimiter,
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
                // Set by reuseExistingCase, which cannot have been skipped: a
                // request without a file never gets past requirePhoto. Stored
                // so the NEXT identical upload finds this case.
                req.photoHash ?? null,
                wantsPublicRecord(req.body),
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
    max: () => positiveIntEnv("TURN_MAX_PER_MINUTE", 120),
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

/**
 * Cheap per row, but not free: every tile is a full row read whose bible is
 * JSON.parsed to yield five strings, and the list is public, so nothing else
 * bounds how often it is asked for. 30 a minute is far above a home page that
 * fetches it once on load.
 */
const perIpDocketLimiter = rateLimit({
    windowMs: 60_000,
    max: () => positiveIntEnv("DOCKET_MAX_PER_MINUTE", 30),
});

/**
 * The public docket: cases their players entered into the public record.
 *
 * Mounted ABOVE GET /:id and it has to stay there - Express takes the first
 * route that matches, so below it "public" is read as a case id and the uuid
 * guard answers "Case not found."
 */
casesRouter.get("/public", perIpDocketLimiter, async (_req, res) => {
    // Not immutable like a READY case: the list changes as cases are published
    // and as old ones age out of retention. A minute is short enough that a
    // player's own case appears while they are still on the page, and long
    // enough that a reload loop costs one query rather than one per hit.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(await listPublicCases());
});

/**
 * A shared link's slug: "biscuit-a1b2c3". Same job as UUID_PATTERN on the id
 * routes - it keeps a junk path from reaching a query, and it bounds the length
 * of a string an anonymous caller puts in a WHERE clause.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;

/**
 * The case behind a shared link. Mounted above /:id like the docket, and for
 * the same reason: below it, "link" is read as a case id.
 *
 * Only a case entered into the public record has a slug at all, so this route
 * cannot reach a private one - which is what makes "only public cases get a
 * link" a property of the data rather than a rule the client is trusted with.
 */
casesRouter.get("/link/:slug", async (req, res) => {
    // Set before the guards so every arm carries it: a case published a moment
    // from now must not be answered "not found" out of a cache, and a malformed
    // slug's 404 is otherwise heuristically cacheable by any shared proxy. The
    // hit overwrites it below.
    res.setHeader("Cache-Control", "no-store");

    const slug = req.params.slug;
    if (typeof slug !== "string" || slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    const result = await findPublicCaseBySlug(slug);
    if (!result) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    // Gated on the status, not on the lookup: findPublicCaseBySlug matches only
    // READY rows, but findCaseStatus answers FAILED for a READY row whose
    // rootNodeId is missing from its own nodes, and caching THAT immutable for
    // a year would make one corrupt bible permanent in every browser that
    // opened the link. Same rule GET /:id follows.
    if (result.status === "READY") {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    res.json(result);
});

/**
 * The operator's takedown, and the only writer of isPublic outside the upload.
 *
 * Publication is deliberately one-way for callers - nothing lets a visitor
 * change someone else's case - which leaves no way at all to answer an abuse
 * report about a photo on the docket short of SQL against production. This is
 * that way, and it is off unless ADMIN_TOKEN is set.
 *
 * Every rejection is the same 404 the unknown-slug arm returns: a 401 would
 * confirm the endpoint exists and is armed, and a 403 would confirm the slug.
 */
casesRouter.delete("/link/:slug", perIpDocketLimiter, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    const slug = req.params.slug;
    if (
        !isOperator(req) ||
        typeof slug !== "string" ||
        slug.length > MAX_SLUG_LENGTH ||
        !SLUG_PATTERN.test(slug)
    ) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    if (!(await unpublishCase(slug))) {
        res.status(404).json({ error: "Case not found." });
        return;
    }
    res.status(204).end();
});

/**
 * Whether the caller holds the operator token.
 *
 * Compared with timingSafeEqual rather than ===, which returns on the first
 * differing byte and leaks the prefix to anyone willing to measure. Length is
 * checked first because timingSafeEqual throws on a length mismatch - that
 * comparison is not constant time, but the length of a secret is not the secret.
 *
 * Absent ADMIN_TOKEN means the route is off, not that every caller is an
 * operator: an unset env var must never open a door.
 */
function isOperator(req: Request): boolean {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
        return false;
    }
    const offered = req.get("x-admin-token");
    if (typeof offered !== "string") {
        return false;
    }
    const a = Buffer.from(offered);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

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
