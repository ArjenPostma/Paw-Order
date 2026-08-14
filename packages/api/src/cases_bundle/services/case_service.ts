import type { CaseAccepted, CaseBible, CaseStatusResponse } from "@paw-order/shared";
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
        verdictRules: { acquitAtDoubt: 60, suspiciousAtSuspicion: 50 },
    };
}

/**
 * Stores the photo, inserts a PENDING row, and returns its id immediately. The
 * bible plus four image calls takes far longer than any edge will hold a
 * request open, so generation continues in the background and the client polls
 * findCaseStatus.
 */
export async function createCase(photo: GeneratedImage): Promise<CaseAccepted> {
    if (inFlight >= MAX_CONCURRENT) {
        throw new GenerationBusyError();
    }
    inFlight += 1;

    try {
        const pending = await insertPendingCase(photo);
        // Deliberately not awaited: the response goes out now. runGeneration owns
        // the slot from here and never rejects.
        void runGeneration(pending.id, pending.photoUrl, photo);
        return { id: pending.id, status: "PENDING" };
    } catch (error: unknown) {
        // Only insertPendingCase can land here; runGeneration is not awaited.
        inFlight -= 1;
        throw error;
    }
}

async function insertPendingCase(photo: GeneratedImage): Promise<{ id: string; photoUrl: string }> {
    const stored = await uploadImage(photo.bytes, photo.mimeType, "dogs");
    try {
        const saved = await repository().save(
            repository().create({ status: "PENDING", bible: placeholderBible(stored.url) }),
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
 * ponytail: fire-and-forget in the api process. A deploy or crash mid-run leaves
 * the row PENDING forever with no one to finish it — the client gives up polling
 * and the player re-uploads. Fix when that matters: a startup sweep that FAILs
 * stale PENDING rows, or a real queue.
 */
async function runGeneration(id: string, photoUrl: string, photo: GeneratedImage): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, TIMEOUT_MS);

    try {
        const { bible, storedKeys } = await generateCaseBible(photoUrl, photo, controller.signal);
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

    const { truth: _truth, ...rest } = entity.bible;
    return { status: "READY", id: entity.id, ...rest };
}
