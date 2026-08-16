import { randomBytes } from "node:crypto";
import { LessThan, MoreThan } from "typeorm";
import type {
    CaseAccepted,
    CaseBible,
    CaseStatusResponse,
    PublicCaseSummary,
} from "@paw-order/shared";
import { publicEvidence, publicNode, publicWitness } from "@paw-order/shared";
import type { GeneratedImage } from "@/ai/gemini";
import { positiveIntEnv } from "@/config/env";
import { AppDataSource } from "@/database_bundle/util/data_source";
import { CaseEntity } from "@/cases_bundle/models/case_entity";
import { GenerationFailure, generateCaseBible } from "@/cases_bundle/services/case_generator";
import { deleteImage, uploadImage } from "@/storage/r2";

/**
 * Concurrent generations, across all callers. The per-ip rate limiter caps how
 * often one client may ask; nothing else caps how many image calls are in flight
 * at once, which is the thing that costs money. Env-tunable so a load test can
 * raise it.
 */
const MAX_CONCURRENT = positiveIntEnv("GENERATION_MAX_CONCURRENT", 3);
/**
 * A hung model call would otherwise leave a row PENDING forever and hold a
 * concurrency slot with it, so every generation gets a deadline.
 */
const TIMEOUT_MS = positiveIntEnv("GENERATION_TIMEOUT_MS", 120_000);
/**
 * How long a case stays playable before it is deleted, row and all.
 *
 * Must stay SHORTER than the R2 lifecycle rule that expires `dogs/` and
 * `evidence/` (DEPLOY.md). The objects are referenced only by url from inside
 * the bible, so nothing here deletes them; if they expired first, a surviving
 * row would serve a trial whose mugshot and every exhibit 404.
 */
const RETENTION_MS = positiveIntEnv("CASE_RETENTION_DAYS", 365) * 24 * 60 * 60 * 1000;
/** How often the retention sweep runs. A container can outlive many windows. */
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How many cases the public docket serves. A strip along the bottom of the home
 * page, the same as the player's own, not an archive - and the ceiling on what
 * one request costs, since every row read here parses a whole bible.
 */
const PUBLIC_DOCKET_SIZE = 12;
/**
 * How much of the case title a slug carries. Long enough for a whole title in
 * most cases, short enough that the url still pastes into a message on one
 * line.
 */
const SLUG_TEXT_MAX = 40;
/** Fresh random tail per attempt. Three clashes in a row is not luck. */
const SLUG_ATTEMPTS = 3;

let inFlight = 0;

/** Thrown when every generation slot is busy. The router answers 503. */
export class GenerationBusyError extends Error {
    constructor() {
        super("All generation slots are busy.");
    }
}

/**
 * Lets the router reject a busy request before multer buffers 8MB and before
 * the daily budget is charged. createCase still re-checks: this is an early
 * out, not the guard - two requests can pass it and only one gets the slot.
 */
export function generationSlotsAvailable(): boolean {
    return inFlight < MAX_CONCURRENT;
}

/** Test seam for the slot accounting, which no HTTP test can observe directly. */
export function generationSlotsInUse(): number {
    return inFlight;
}

function repository() {
    return AppDataSource.getRepository(CaseEntity);
}

/**
 * Placeholder contents for the PENDING row. Never served: findCaseStatus returns
 * status only until the row is READY. It exists because `bible` is not nullable
 * and the real one does not exist yet.
 */
function placeholderBible(photoUrl: string): CaseBible {
    return {
        defendant: { name: "Unnamed", photoUrl },
        crime: {
            charge: "Pending investigation",
            title: "Untitled Case",
            location: "",
            timeline: [],
        },
        truth: { summary: "", misleadingEvidenceIds: [] },
        evidence: [],
        witnesses: [],
        nodes: [],
        rootNodeId: "",
        // Out of reach on purpose. All-zero thresholds fail OPEN - every state
        // satisfies `doubt >= 0` - so a placeholder that ever reached a verdict
        // would acquit. Nothing reaches it today (findCaseStatus and playTurn
        // both gate on READY, and replayRun gates again on the empty root), but
        // a bible that is by definition not a case should refuse to acquit.
        verdictRules: {
            acquitAtDoubt: Number.MAX_SAFE_INTEGER,
            reasonableDoubtAtDoubt: Number.MAX_SAFE_INTEGER,
            suspiciousAtSuspicion: Number.MAX_SAFE_INTEGER,
        },
    };
}

/**
 * Stores the photo, inserts a PENDING row, and returns its id immediately. The
 * bible plus its exhibit images takes far longer than any edge will hold a
 * request open, so generation continues in the background and the client polls
 * findCaseStatus.
 */
export async function createCase(
    photo: GeneratedImage,
    defendantName: string,
    photoHash: string | null,
    isPublic: boolean,
): Promise<CaseAccepted> {
    if (inFlight >= MAX_CONCURRENT) {
        throw new GenerationBusyError();
    }
    inFlight += 1;

    try {
        const pending = await insertPendingCase(photo, photoHash, isPublic);
        // Deliberately not awaited: the response goes out now. runGeneration owns
        // the slot from here and never rejects.
        void runGeneration(pending.id, pending.photoUrl, photo, defendantName, isPublic);
        return { id: pending.id, status: "PENDING" };
    } catch (error: unknown) {
        // Only insertPendingCase can land here; runGeneration is not awaited.
        inFlight -= 1;
        throw error;
    }
}

/**
 * The case an identical submission should be handed back instead of generating
 * a new one.
 *
 * PENDING counts as reusable, not just READY: a double-submit should join the
 * generation already running for those exact bytes rather than start a second
 * one. FAILED deliberately does not - re-uploading a photo whose case fell apart
 * is the player retrying, and they must get a real attempt.
 *
 * isPublic is deliberately not part of the match, and a hit does not change it,
 * in EITHER direction. Ticking the box and hitting a case generated privately
 * does nothing - publishing a row on the say-so of a second caller who only
 * proved they hold the same file is worse than a rare no-op. Leaving the box
 * clear and hitting a case someone else published also does nothing, so that
 * caller is handed a case that is already on the docket and already has a link:
 * their upload published nothing, but the case they are looking at is public
 * and the client will say so. Both need the same byte-identical photo under the
 * same name, which is what makes it rare enough to accept.
 */
export async function findReusableCase(photoHash: string): Promise<CaseAccepted | null> {
    const entity = await repository().findOne({
        where: [
            { photoHash, status: "READY" },
            // Only a generation that could still be alive. runGeneration is
            // fire-and-forget in this process, so a deploy or crash mid-run
            // strands the row PENDING with nobody left to fail it - and an
            // unbounded match here handed that corpse back to every future
            // upload of the same photo, forever. The player's natural retry
            // (same file, same name) was the one thing that could never
            // recover. Past the deadline the row falls through and generates.
            {
                photoHash,
                status: "PENDING",
                createdAt: MoreThan(new Date(Date.now() - TIMEOUT_MS)),
            },
        ],
        // Newest wins. Two rows can share a hash: a PENDING one that later
        // failed leaves the row FAILED and the retry inserts another.
        order: { createdAt: "DESC" },
    });
    return entity ? { id: entity.id, status: entity.status } : null;
}

/**
 * The readable half of a slug: lowercase, url characters only.
 *
 * Built from the case TITLE, not the defendant's name. The title is what the
 * link is about, and a player's own name for their dog is a more personal thing
 * to put in a url that gets pasted around than the-great-birthday-cake-heist.
 *
 * Accents are decomposed and their marks dropped, so "Café" is "cafe" rather
 * than "caf". A title past the budget is cut at a word rather than mid-word.
 * One with nothing left after all that - a title written in a script this keeps
 * none of - falls back to "case"; the six hex that follow are what actually
 * identify the row, the words are only there so the link reads like something.
 *
 * Exported for its own test: the fixture has one title, so the cut and the
 * fallback are unreachable through the HTTP suite.
 */
export function slugStem(title: string): string {
    const cleaned = title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (cleaned.length <= SLUG_TEXT_MAX) {
        return cleaned || "case";
    }
    // MAX + 1, so a separator sitting exactly on the boundary is visible. Cut at
    // MAX and that separator is the first character not looked at, so the last
    // word that does fit gets thrown away with the one that does not.
    const cut = cleaned.slice(0, SLUG_TEXT_MAX + 1);
    const lastWord = cut.lastIndexOf("-");
    // > 0, not >= 0: a single word longer than the budget has no hyphen to cut
    // back to, and cutting at index 0 would leave nothing at all. No trailing
    // trim and no fallback needed on this path - separators are collapsed and
    // the ends already trimmed, so both branches return a non-empty stem that
    // cannot end in one.
    return lastWord > 0 ? cut.slice(0, lastWord) : cut.slice(0, SLUG_TEXT_MAX);
}

/**
 * A slug no case is using. Checked rather than constrained: see the note on the
 * column. The check and the write are not atomic, and nothing here pretends
 * otherwise - two cases colliding on the same title AND the same six hex in the
 * same instant is not a race worth a transaction.
 */
async function generateSlug(title: string): Promise<string> {
    const stem = slugStem(title);
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
        const candidate = `${stem}-${randomBytes(3).toString("hex")}`;
        try {
            if (!(await repository().existsBy({ slug: candidate }))) {
                return candidate;
            }
        } catch (error: unknown) {
            // The caller runs inside the update whose failure deletes every
            // exhibit image and fails the case, so a blip on this read - which
            // guards nothing worse than a 1-in-16.7M shared link - must not be
            // what throws away a case with all five model calls paid for. Take
            // the long tail and carry on.
            console.error("[paw-order-api] could not check slug uniqueness", error);
            break;
        }
    }
    // Three clashes against 16.7 million per title means the random source is
    // broken, not that the player is unlucky. A longer tail is cheaper than
    // failing a case whose images are already paid for.
    return `${stem}-${randomBytes(6).toString("hex")}`;
}

async function insertPendingCase(
    photo: GeneratedImage,
    photoHash: string | null,
    isPublic: boolean,
): Promise<{ id: string; photoUrl: string }> {
    const stored = await uploadImage(photo.bytes, photo.mimeType, "dogs");
    try {
        const saved = await repository().save(
            repository().create({
                status: "PENDING",
                bible: placeholderBible(stored.url),
                photoHash,
                isPublic,
                // The slug is written with the bible, not here: it is built
                // from the case title, which does not exist until the
                // generator has run. A row that never gets that far keeps the
                // null it was inserted with, and a case with no slug has no
                // link - which is the same state a private case is in.
            }),
        );
        return { id: saved.id, photoUrl: stored.url };
    } catch (error: unknown) {
        // The object is written before the row exists, so a failure here leaves a
        // paid object nothing references and nothing reaps.
        await deleteImage(stored.key);
        throw error;
    }
}

/**
 * Marks PENDING rows past the generation deadline as FAILED. Their runGeneration
 * died with the process that started it - no timer is left to fail them, and the
 * client would poll a row nobody is working on until it gives up.
 *
 * The deadline filter is what makes this safe to run at any moment rather than
 * only at boot: a row still inside it may be a live generation, either one of
 * this process's own or - during an overlapping deploy - one in the container
 * that is still serving. Past the deadline no generation can still be running
 * anywhere, because every one of them carries an AbortController set to exactly
 * this timeout.
 */
export async function failStalePendingCases(): Promise<number> {
    const { affected } = await repository().update(
        { status: "PENDING", createdAt: LessThan(new Date(Date.now() - TIMEOUT_MS)) },
        { status: "FAILED" },
    );
    // Postgres and better-sqlite3 both report a count here, but the driver
    // contract allows null, and a swept row is not worth a crash at boot.
    return affected ?? 0;
}

/**
 * Sweeps at boot and once more a deadline later, then stops.
 *
 * The second pass is not housekeeping, it is the whole point: a row uploaded
 * seconds before the previous process died is still inside its deadline when
 * this one boots, so the first sweep passes over it deliberately, and boot is
 * the last chance anything looks. One more pass a deadline later catches
 * exactly that window, by which time the row cannot be alive anywhere. Without
 * it the client polls a dead row for its full three minutes - the symptom the
 * sweep exists to remove, just moved.
 *
 * ponytail: two passes, not a running timer. A crash while this process is up
 * strands its own rows until the next boot; a real queue with visibility
 * timeouts is the fix if that ever matters.
 */
export function sweepStalePendingCases(): void {
    const run = (): void => {
        failStalePendingCases()
            .then((swept) => {
                if (swept > 0) {
                    console.log(`[paw-order-api] failed ${String(swept)} stale pending case(s)`);
                }
            })
            .catch((error: unknown) => {
                // Housekeeping. Losing it costs a stale row, and an unhandled
                // rejection would cost the process.
                console.error("[paw-order-api] could not sweep stale pending cases", error);
            });
    };
    run();
    // unref: a pending sweep must never be the reason the process stays up.
    setTimeout(run, TIMEOUT_MS).unref();
}

/**
 * Deletes cases past the retention window. Every status goes: a year-old FAILED
 * row is as dead as a year-old READY one, and nothing reuses either.
 *
 * The paired R2 objects are not touched here - the bucket's own lifecycle rule
 * expires them on a longer window, which also reaps the objects no row ever
 * referenced (a crash between upload and insert). Deleting them from here would
 * mean parsing keys back out of urls stored in the bible and would still miss
 * those.
 *
 * ponytail: full scan, nothing indexes createdAt. Once a day against a table one
 * anonymous game fills is not worth a migration; add the index when the scan
 * shows up in query timings.
 */
export async function deleteExpiredCases(): Promise<number> {
    const { affected } = await repository().delete({
        // Stored as TIMESTAMP without time zone by a writer running UTC, and
        // this Date is UTC too (see case_entity.ts).
        createdAt: LessThan(new Date(Date.now() - RETENTION_MS)),
    });
    return affected ?? 0;
}

/** Deletes expired cases at boot and once a day after. */
export function startCaseRetention(): void {
    const run = (): void => {
        deleteExpiredCases()
            .then((deleted) => {
                if (deleted > 0) {
                    console.log(`[paw-order-api] deleted ${String(deleted)} expired case(s)`);
                }
            })
            .catch((error: unknown) => {
                // Housekeeping. Losing a pass costs a day of storage; an
                // unhandled rejection costs the process.
                console.error("[paw-order-api] could not delete expired cases", error);
            });
    };
    run();
    // unref: retention must never be the reason the process stays up.
    setInterval(run, RETENTION_INTERVAL_MS).unref();
}

/**
 * ponytail: fire-and-forget in the api process. A deploy or crash mid-run leaves
 * the row PENDING with no one to finish it until a sweep reaches it. A real
 * queue is the fix if that gap matters.
 */
async function runGeneration(
    id: string,
    photoUrl: string,
    photo: GeneratedImage,
    defendantName: string,
    isPublic: boolean,
): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, TIMEOUT_MS);

    try {
        const { bible, storedKeys } = await generateCaseBible(
            photoUrl,
            photo,
            defendantName,
            controller.signal,
        );
        try {
            await repository().update(id, {
                bible,
                status: "READY",
                // Written in the same update as the bible it is built from, so
                // a READY public case always has its link and a row can never
                // be found published with a slug describing an older title.
                slug: isPublic ? await generateSlug(bible.crime.title) : null,
            });
        } catch (error: unknown) {
            // The images are written but no row will ever reference them.
            await Promise.all(storedKeys.map(deleteImage));
            throw error;
        }
    } catch (error: unknown) {
        // A timeout during the tree stage arrives wrapped as GenerationFailure,
        // so testing the wrapper first would report every timeout as a plain
        // stage failure and the deadline diagnosis would never be printed.
        // Abort is the more specific fact: ask it first.
        const failure = error instanceof GenerationFailure ? error : null;
        const where = failure ? ` at stage: ${failure.stage}` : "";
        // The wrapper only exists to carry the keys; the reason underneath is
        // what is worth reading, so log that rather than a nested toString.
        const reason = failure ? failure.reason : error;

        if (controller.signal.aborted) {
            console.error(
                `[paw-order-api] case ${id} timed out after ${String(TIMEOUT_MS)}ms${where}`,
                reason,
            );
        } else {
            console.error(`[paw-order-api] case ${id} failed${where}`, reason);
        }

        if (failure && failure.storedKeys.length > 0) {
            console.error(
                `[paw-order-api] case ${id}: reclaiming ${String(failure.storedKeys.length)} orphaned images`,
            );
            await Promise.all(failure.storedKeys.map(deleteImage));
        }
        await markFailed(id);
    } finally {
        clearTimeout(timer);
        inFlight -= 1;
    }
}

/**
 * The dog photo is deliberately left in the bucket: the row still references it
 * and the client may show it on the failure screen. Reaping both is the job of
 * the retention policy case_entity.ts already flags as missing.
 */
async function markFailed(id: string): Promise<void> {
    try {
        await repository().update(id, { status: "FAILED" });
    } catch (error: unknown) {
        // Losing this leaves a permanently PENDING row, which is survivable; an
        // unhandled rejection in a background task is not.
        console.error("[paw-order-api] could not mark case failed", id, error);
    }
}

/**
 * The public docket: the newest cases whose players entered them into the
 * public record, as tiles.
 *
 * Both filters are columns, so nothing queries inside the bible - the fields
 * the tile needs are read off it here, after the rows are in hand. That does
 * mean each row parses a whole bible to yield five strings, which is what
 * PUBLIC_DOCKET_SIZE and the route's cache header bound.
 *
 * READY only: a PENDING row holds the placeholder bible, whose defendant is
 * "Unnamed" and whose charge is "Pending investigation", and a FAILED one holds
 * whatever it died with. Neither is a case anyone can open.
 *
 * ponytail: nothing indexes isPublic or createdAt, so this is a sequential scan
 * plus a sort of the whole table - and unlike the retention sweep, which pays
 * that once a day from a timer, this one pays it per anonymous request. The
 * route's max-age reaches browsers only (the api is Railway-direct, not behind
 * the Pages CDN), so N distinct visitors are N scans. Add the composite index
 * on (isPublic, status, createdAt), or memoise for the 60s the route already
 * advertises, when the table is big enough for either to show in query timings.
 */
export async function listPublicCases(): Promise<PublicCaseSummary[]> {
    const entities = await repository().find({
        where: { isPublic: true, status: "READY" },
        order: { createdAt: "DESC" },
        take: PUBLIC_DOCKET_SIZE,
    });
    // Field by field, never a spread: this list goes to people who did not
    // generate these cases, so a bible field must not be able to arrive here by
    // accident. Same rule as findCaseStatus, and it matters more.
    return entities.map((entity) => ({
        id: entity.id,
        name: entity.bible.defendant.name,
        charge: entity.bible.crime.charge,
        photoUrl: entity.bible.defendant.photoUrl,
    }));
}

/**
 * The case behind a shared link.
 *
 * Public and READY only, which is the access rule stated twice: a private case
 * has no slug to match in the first place, and this refuses to serve one even
 * if a slug somehow outlived the flag. Then it hands off to findCaseStatus, so
 * a link and an id serve byte-identical bodies through the same code.
 *
 * Two reads rather than one, and the first is id-only so nothing parses a bible
 * to answer a miss. Newest wins for the same reason it does in findReusableCase:
 * the column is not unique.
 */
export async function findPublicCaseBySlug(slug: string): Promise<CaseStatusResponse | null> {
    const entity = await repository().findOne({
        where: { slug, isPublic: true, status: "READY" },
        order: { createdAt: "DESC" },
        select: { id: true },
    });
    return entity ? findCaseStatus(entity.id) : null;
}

/**
 * Takes a case off the public docket and kills its link.
 *
 * The only writer of isPublic outside the upload that created the row, and it
 * only ever writes false: publication stays one-way for callers, so nobody can
 * publish someone else's dog, and the operator can still answer an abuse report
 * before retention deletes the row a year later.
 *
 * Keyed on the slug, not the id: the id is on the docket for anyone to read.
 * The row itself is left alone - the player holding the id in localStorage can
 * still replay their own case, which is the smallest thing that answers the
 * complaint. The R2 objects stay too; the bucket's lifecycle rule reaps them.
 */
export async function unpublishCase(slug: string): Promise<boolean> {
    const { affected } = await repository().update(
        { slug, isPublic: true },
        { isPublic: false, slug: null },
    );
    // Postgres and better-sqlite3 both report a count, but the driver contract
    // allows null; treat unknown as "nothing matched" so the route answers 404
    // rather than claiming a takedown it cannot prove.
    return (affected ?? 0) > 0;
}

export async function findCaseStatus(id: string): Promise<CaseStatusResponse | null> {
    const entity = await repository().findOne({ where: { id } });
    if (!entity) {
        return null;
    }
    if (entity.status !== "READY") {
        // No bible leaves the api until it is a real one.
        return { id: entity.id, status: entity.status };
    }

    // Several things come off the bible here, not one. `truth` is the obvious
    // secret; `witnesses[].reliable` is the quiet one - it names which testimony
    // is false, which is the same answer by another route. imagePrompt goes too:
    // nothing renders it and it is a paragraph of model prose per exhibit.
    //
    // The trial itself now leaves one node at a time: `nodes` carried the whole
    // effects table and every edge, and `verdictRules` the number to farm
    // towards. The player gets the opening node and posts back to /turn.
    const { defendant, crime, witnesses, evidence, nodes, rootNodeId } = entity.bible;

    const rootNode = nodes.find((node) => node.id === rootNodeId);
    if (!rootNode) {
        // Unreachable for a stored bible: validateTree rejects a rootNodeId that
        // is not a node. Reported as FAILED rather than as a miss, because a 404
        // reads as transient to the client's poll loop and it would keep asking
        // for ten more seconds about a permanent condition.
        console.error(`[paw-order-api] case ${entity.id} is READY with no root node`);
        return { id: entity.id, status: "FAILED" };
    }

    // Listed field by field, never spread. `rest` would carry any field added
    // to CaseBible later straight onto the wire, which is how a secret ships
    // without anyone deciding to ship it.
    const openingExhibits = new Set(rootNode.evidenceIds);
    return {
        status: "READY",
        id: entity.id,
        // Null unless the case was entered into the public record. The client
        // reads it as "may this be shared", and there is nothing else to read:
        // a case with no slug has no url to hand anyone.
        slug: entity.slug,
        defendant,
        crime,
        rootNode: publicNode(rootNode),
        // Only what the opening statement puts in play. The rest arrive from
        // /turn as the trial unlocks them.
        evidence: evidence.filter((exhibit) => openingExhibits.has(exhibit.id)).map(publicEvidence),
        witnesses: witnesses.map(publicWitness),
    };
}
