import { LessThan, MoreThan } from "typeorm";
import type { CaseAccepted, CaseBible, CaseStatusResponse } from "@paw-order/shared";
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
): Promise<CaseAccepted> {
    if (inFlight >= MAX_CONCURRENT) {
        throw new GenerationBusyError();
    }
    inFlight += 1;

    try {
        const pending = await insertPendingCase(photo, photoHash);
        // Deliberately not awaited: the response goes out now. runGeneration owns
        // the slot from here and never rejects.
        void runGeneration(pending.id, pending.photoUrl, photo, defendantName);
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

async function insertPendingCase(
    photo: GeneratedImage,
    photoHash: string | null,
): Promise<{ id: string; photoUrl: string }> {
    const stored = await uploadImage(photo.bytes, photo.mimeType, "dogs");
    try {
        const saved = await repository().save(
            repository().create({
                status: "PENDING",
                bible: placeholderBible(stored.url),
                photoHash,
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
 * ponytail: fire-and-forget in the api process. A deploy or crash mid-run leaves
 * the row PENDING with no one to finish it until a sweep reaches it. A real
 * queue is the fix if that gap matters.
 */
async function runGeneration(
    id: string,
    photoUrl: string,
    photo: GeneratedImage,
    defendantName: string,
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
            await repository().update(id, { bible, status: "READY" });
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
        defendant,
        crime,
        rootNode: publicNode(rootNode),
        // Only what the opening statement puts in play. The rest arrive from
        // /turn as the trial unlocks them.
        evidence: evidence.filter((exhibit) => openingExhibits.has(exhibit.id)).map(publicEvidence),
        witnesses: witnesses.map(publicWitness),
    };
}
