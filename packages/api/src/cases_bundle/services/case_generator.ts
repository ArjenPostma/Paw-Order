import type { Schema } from "@google/genai";
import type { CaseBible, Evidence } from "@paw-order/shared";
import { IMAGE_MODEL, TEXT_MODEL, encodeImage, generateImage, generateJson } from "@/ai/gemini";
import type { EncodedImage, GeneratedImage } from "@/ai/gemini";
import { positiveIntEnv, resolveAppEnv } from "@/config/env";
import { fixtureBible } from "@/cases_bundle/services/case_fixture";
import {
    DOG_CHECK_PROMPT,
    DOG_SCHEMA,
    FACTS_SCHEMA,
    TREE_SCHEMA,
    factsPrompt,
    treePrompt,
} from "@/cases_bundle/services/case_prompt";
import { validateFacts, validateTree } from "@/cases_bundle/services/case_validator";
import type { ValidationResult } from "@/cases_bundle/services/case_validator";
import { uploadExhibit, uploadThumbnail } from "@/storage/r2";

export interface GeneratedCase {
    bible: CaseBible;
    /** R2 keys this run wrote, so a later failure can reclaim them. */
    storedKeys: string[];
}

/**
 * Carries the orphaned keys out with the failure so the caller can delete them.
 * `stage` is in the message because this error is what reaches the api log, and
 * "generation failed" without the stage means reading a stack trace to learn
 * whether the facts, the images or the tree were the problem.
 */
export class GenerationFailure extends Error {
    constructor(
        readonly stage: string,
        readonly storedKeys: string[],
        readonly reason: unknown,
    ) {
        super(`Case generation failed at stage: ${stage} (after writing images)`);
    }
}

/** One retry. A model that fails the validator twice is not going to converge. */
const MAX_ATTEMPTS = 2;

/**
 * Asks for JSON, validates it, and on rejection asks again with the reasons.
 * The feedback loop is the whole point: "nextNodeId N9 is not a node" is
 * something a model can act on, where a bare retry just rolls the dice again.
 *
 * Exported for its test only, on the same grounds as renderEvidence below:
 * generateCaseBible answers the fixture under APP_ENV=test and never reaches
 * this, so MAX_ATTEMPTS - the bound on how many paid calls one stage can make -
 * could be raised, or the loop left without an exit, with the suite still green.
 */
export async function generateValidated<T>(
    stage: string,
    prompt: string,
    schema: Schema,
    validate: (value: unknown) => ValidationResult<T>,
    options: { reference?: EncodedImage; signal?: AbortSignal },
): Promise<T> {
    let feedback = "";
    let lastErrors: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let text: string;
        try {
            text = await generateJson(prompt + feedback, schema, options);
        } catch (error: unknown) {
            // A 400 here is the REQUEST being rejected, not the answer, and the
            // api never says which field it disliked. Naming the stage is what
            // narrows it down: the two stages send different schemas, and the
            // tree one is the schema that has already caused this once (see the
            // TREE_SCHEMA note about minItems on nested arrays).
            console.error(
                `[paw-order-api] ${stage}: Gemini rejected the request itself on attempt ${String(attempt)}.`,
                `model=${TEXT_MODEL} promptChars=${String((prompt + feedback).length)} schemaKeys=${describeSchema(schema)}`,
                error,
            );
            throw error;
        }

        const parsed = parseJson(text);
        if (parsed === null) {
            // Distinguishable from a schema violation: the response was not JSON
            // at all, which usually means a truncated answer or a safety block.
            console.warn(
                `[paw-order-api] ${stage}: response was not JSON on attempt ${String(attempt)}, ${String(text.length)} chars`,
            );
        }

        const result = validate(parsed);
        if (result.ok) {
            return result.value;
        }
        lastErrors = result.errors;

        // Never log `text` itself: it is a model response that may be arbitrarily
        // long, and the reasons already name every field that failed.
        console.warn(
            `[paw-order-api] ${stage}: response rejected on attempt ${String(attempt)} of ${String(MAX_ATTEMPTS)} for ${String(result.errors.length)} reasons:\n  - ${result.errors.join("\n  - ")}`,
        );
        feedback = `\n\nYour previous answer was rejected for these reasons:\n${result.errors
            .map((error) => `- ${error}`)
            .join("\n")}\nReturn corrected JSON that fixes every one of them.`;
    }

    // Carry the reasons into the message: this is the error that reaches the
    // request log, and "failed validation twice" on its own says nothing.
    throw new Error(
        `${stage} failed validation ${String(MAX_ATTEMPTS)} times. Last reasons: ${lastErrors.join("; ")}`,
    );
}

/** Top-level property names only — enough to tell the two schemas apart. */
function describeSchema(schema: Schema): string {
    return Object.keys(schema.properties ?? {}).join(",");
}

/** A model can return non-JSON despite responseMimeType; that is a rejection. */
function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Renders every exhibit concurrently, so the wall clock is one image rather than
 * one per exhibit. allSettled, not all: a refused or malformed image leaves that
 * exhibit pictureless (Evidence.imageUrl is nullable for exactly this) and the
 * trial still plays. Losing a whole generated case to one flaky call is worse.
 *
 * Exported for its test only: generateCaseBible answers the fixture under
 * APP_ENV=test and never reaches this, so without a seam here the whole
 * full-plus-thumbnail wiring could be deleted with every test still green.
 */
export async function renderEvidence(
    evidence: Evidence[],
    photo: EncodedImage,
    signal: AbortSignal,
): Promise<{ evidence: Evidence[]; storedKeys: string[] }> {
    const results = await Promise.allSettled(
        evidence.map(async (exhibit) => {
            const image = await generateImage(exhibit.imagePrompt, photo, signal);
            const full = await uploadExhibit(image.bytes, image.mimeType, "evidence", signal);
            // Sequential, not concurrent: the resize is CPU work on bytes the
            // upload above already holds, and every exhibit in the case is
            // running this same block at once.
            const thumb = await uploadThumbnail(image.bytes, "evidence", signal);
            return { full, thumb };
        }),
    );

    const storedKeys: string[] = [];
    const rendered = evidence.map((exhibit, index) => {
        const result = results[index];
        if (!result || result.status === "rejected") {
            console.error(
                `[paw-order-api] exhibit ${exhibit.id} has no image (model=${IMAGE_MODEL}). The trial still plays without it.`,
                result?.status === "rejected" ? result.reason : "missing result",
            );
            return exhibit;
        }
        const { full, thumb } = result.value;
        if (full.key !== null) {
            storedKeys.push(full.key);
        }
        if (thumb?.key != null) {
            storedKeys.push(thumb.key);
        }
        return { ...exhibit, imageUrl: full.url, thumbUrl: thumb?.url ?? null };
    });

    // One pictureless exhibit is a survivable trial. All of them is not a case -
    // it means the image model is down, out of quota, or refused the whole batch,
    // and every visual claim the trial makes would point at nothing. Better a
    // FAILED the player can retry than a READY case with no evidence in it.
    if (!rendered.some((exhibit) => exhibit.imageUrl !== null)) {
        const firstRejection = results.find((result) => result.status === "rejected");
        throw new GenerationFailure(
            "evidence images",
            storedKeys,
            firstRejection?.status === "rejected"
                ? firstRejection.reason
                : new Error("no exhibit produced an image"),
        );
    }

    return { evidence: rendered, storedKeys };
}

/**
 * How long the upload request will wait on the dog check. It runs inside the
 * POST, so this is a bound on the player's wait, not on a background job -
 * short on purpose, and short enough that the fall-open below is reached long
 * before any edge gives up on the request.
 */
const DOG_CHECK_TIMEOUT_MS = positiveIntEnv("DOG_CHECK_TIMEOUT_MS", 8_000);

/**
 * Concurrent dog checks.
 *
 * Each one holds the uploaded photo (up to the 20MB upload cap) and the base64
 * copy encodeImage makes of it (~1.34x that) alive for as long as the call
 * takes, and it runs before createCase, so the generation slot counter never
 * sees it and never bounds it. Uncapped, that is ~47MB per in-flight upload with
 * only a per-minute per-ip limiter deciding how many could overlap.
 *
 * Two, at that size, is ~54MB of base64 on top of the buffers the upload ceiling
 * already bounds. It came down when the upload cap went up; the two multiply.
 */
const maxConcurrentDogChecks = (): number => positiveIntEnv("DOG_CHECK_MAX_CONCURRENT", 2);

let dogChecksInFlight = 0;

/** Thrown when every dog-check slot is busy. The router answers 503. */
export class DogCheckBusyError extends Error {
    constructor() {
        super("All dog check slots are busy.");
    }
}

/**
 * Lets the router shed a busy request BEFORE the dog-check budget is charged.
 *
 * Without it the 503 below spent a slot of a 24h budget that exists to bound
 * model spend, on a request that made no model call at all - so an ordinary
 * burst of concurrent uploads could close the court for the day having cost
 * nothing to serve. Same early-out shape as generationSlotsAvailable: two
 * requests can pass it and only one gets the slot, which acquire below decides.
 */
export function dogCheckSlotsAvailable(): boolean {
    return dogChecksInFlight < maxConcurrentDogChecks();
}

/** Takes a slot, or reports that every one is busy. Paired with release. */
export function acquireDogCheckSlot(): boolean {
    if (!dogCheckSlotsAvailable()) {
        return false;
    }
    dogChecksInFlight += 1;
    return true;
}

export function releaseDogCheckSlot(): void {
    if (dogChecksInFlight > 0) {
        dogChecksInFlight -= 1;
    }
}

/** What the upload gate answers. Both fields are the model's, both narrowed. */
export interface PhotoScreening {
    /** Whether there is a dog in it at all. False turns the upload away. */
    isDog: boolean;
    /** Whether the whole frame can go on the docket. False refuses publication. */
    safeForPublic: boolean;
}

/**
 * The two fields DOG_SCHEMA asks for, narrowed off an untrusted response.
 *
 * The two halves fall opposite ways on a malformed answer, which is the whole
 * reason this is one function rather than two `=== true` checks: isDog false is
 * the caller's cue to fall open, and safeForPublic false is already the safe
 * side, so a model that answers with the string "true" is refused publication
 * rather than granted it.
 */
export function readScreening(value: unknown): PhotoScreening {
    const answered = typeof value === "object" && value !== null;
    return {
        isDog: answered && "isDog" in value && value.isDog === true,
        safeForPublic: answered && "safeForPublic" in value && value.safeForPublic === true,
    };
}

/**
 * Whether the photo has a dog in it and whether it can be shown in public, both
 * asked before anything is paid for.
 *
 * One cheap text call against the same photo the exhibits would be rendered
 * from. It is the only guard between an anonymous upload and four paid calls,
 * and the router mounts it ahead of both daily ceilings so a rejected photo
 * spends neither.
 *
 * isDog fails OPEN. A model outage here would otherwise turn every upload away
 * at the door, and it costs nothing to let one through: if Gemini is down, the
 * facts stage is the next thing to run and it fails before an image is ever
 * rendered.
 *
 * safeForPublic fails CLOSED, on the same non-answers. An unscreened photo must
 * not reach the front page, and refusing it costs the player only the tick box -
 * the case itself still generates and still plays. During the outage that makes
 * isDog fall open, nothing reaches READY anyway, so there is no case to publish.
 */
export async function screenPhoto(photo: GeneratedImage): Promise<PhotoScreening> {
    // Ahead of the test short-circuit, not behind it: the slot accounting is a
    // memory bound the suite has to be able to reach, and every path out of this
    // function releases through the same finally either way.
    if (!acquireDogCheckSlot()) {
        throw new DogCheckBusyError();
    }

    try {
        return await runScreening(photo);
    } finally {
        releaseDogCheckSlot();
    }
}

async function runScreening(photo: GeneratedImage): Promise<PhotoScreening> {
    if (resolveAppEnv() === "test") {
        // The suite must never reach Gemini. Same guard shape as r2.ts.
        //
        // The two knobs are the seam the router's rejections are tested through,
        // and the only one there is: with a flat `true` here no HTTP test can
        // produce either 400, so both gates could be deleted from the router and
        // the suite would stay green - including the one that keeps an
        // unscreened photo off the front page. Read per call rather than at
        // module load, so a test can set one for a request and clear it again,
        // and unreachable outside APP_ENV=test.
        return {
            isDog: process.env.TEST_PHOTO_IS_DOG !== "false",
            safeForPublic: process.env.TEST_PHOTO_IS_SAFE !== "false",
        };
    }

    try {
        const text = await generateJson(DOG_CHECK_PROMPT, DOG_SCHEMA, {
            reference: encodeImage(photo),
            signal: AbortSignal.timeout(DOG_CHECK_TIMEOUT_MS),
        });
        const parsed = parseJson(text);
        if (parsed === null) {
            // A 200 whose body is not JSON is the same class of non-answer as a
            // thrown error, and must fall the same way. Read as a plain false it
            // would tell a player holding a real dog that it is not a dog, which
            // is the one outcome DOG_CHECK_PROMPT is written to avoid.
            console.warn(
                `[paw-order-api] dog check answered with ${String(text.length)} chars of non-JSON, letting the upload through unpublished`,
            );
            return { isDog: true, safeForPublic: false };
        }
        return readScreening(parsed);
    } catch (error: unknown) {
        console.error(
            `[paw-order-api] dog check did not answer (model=${TEXT_MODEL}), letting the upload through unpublished`,
            error,
        );
        return { isDog: true, safeForPublic: false };
    }
}

/**
 * The generation seam: photo in, complete Case Bible out. Everything downstream
 * (persistence, the trial engine, the verdict) reads only this return value.
 *
 * Facts first, then images, then the trial tree — the tree is generated last so
 * it can only be built from exhibits that already exist (gamedesign.md §12).
 */
export async function generateCaseBible(
    photoUrl: string,
    photo: GeneratedImage,
    defendantName: string,
    signal: AbortSignal,
): Promise<GeneratedCase> {
    if (resolveAppEnv() === "test") {
        // The suite must never reach Gemini. Same guard shape as r2.ts.
        return { bible: fixtureBible(photoUrl, defendantName), storedKeys: [] };
    }

    // Encoded once and shared by all five calls, rather than per call.
    const reference = encodeImage(photo);

    const facts = await generateValidated(
        "case facts",
        factsPrompt(defendantName),
        FACTS_SCHEMA,
        validateFacts,
        { reference, signal },
    );

    const { evidence, storedKeys } = await renderEvidence(facts.evidence, reference, signal);

    // From here on this run owns paid objects, so the caller needs the keys even
    // when the tree stage throws.
    try {
        const tree = await generateValidated(
            "trial tree",
            treePrompt({ ...facts, evidence }, defendantName),
            TREE_SCHEMA,
            (value) => validateTree(value, evidence),
            { signal },
        );

        return {
            bible: {
                defendant: { name: defendantName, photoUrl },
                crime: facts.crime,
                truth: facts.truth,
                evidence,
                witnesses: facts.witnesses,
                nodes: tree.nodes,
                rootNodeId: tree.rootNodeId,
                verdictRules: tree.verdictRules,
            },
            storedKeys,
        };
    } catch (error: unknown) {
        throw new GenerationFailure("trial tree", storedKeys, error);
    }
}
