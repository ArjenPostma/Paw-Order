import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@google/genai";
import type { Evidence } from "@paw-order/shared";
import {
    DogCheckBusyError,
    acquireDogCheckSlot,
    dogCheckSlotsAvailable,
    generateValidated,
    readScreening,
    releaseDogCheckSlot,
    renderEvidence,
    screenPhoto,
} from "@/cases_bundle/services/case_generator";
import type { ValidationResult } from "@/cases_bundle/services/case_validator";
import { uploadExhibit, uploadThumbnail } from "@/storage/r2";
import { generateImage, generateJson } from "@/ai/gemini";

// The model call and the bucket are both mocked: what is under test is the
// wiring between them - that every exhibit gets a full image AND a strip copy,
// that both keys are handed back for reclaim, and that the URLs land on the
// right fields. The resize itself is tested against real bytes in r2.test.ts.
vi.mock("@/ai/gemini", () => ({
    TEXT_MODEL: "text-model",
    IMAGE_MODEL: "image-model",
    generateImage: vi.fn(),
    generateJson: vi.fn(),
    encodeImage: vi.fn(),
}));

vi.mock("@/storage/r2", () => ({
    uploadExhibit: vi.fn(),
    uploadThumbnail: vi.fn(),
}));

function exhibit(id: string): Evidence {
    return {
        id,
        label: `Exhibit ${id}`,
        imagePrompt: `a photograph for ${id}`,
        imageUrl: null,
        thumbUrl: null,
        visualFacts: ["something visible"],
    };
}

const photo = { base64: "", mimeType: "image/jpeg" };

/**
 * The dog check's answer is a model response, so it is narrowed rather than
 * read. screenPhoto itself short-circuits under APP_ENV=test and never reaches
 * the model, which leaves this narrowing as the only part of the gate a test
 * can actually execute - and the part where a rewrite would silently start
 * accepting a string, a number or a missing field as "yes".
 */
describe("readScreening", () => {
    it("accepts only the boolean true, on both answers", () => {
        expect(readScreening({ isDog: true, safeForPublic: true })).toEqual({
            isDog: true,
            safeForPublic: true,
        });
        expect(readScreening({ isDog: false, safeForPublic: false })).toEqual({
            isDog: false,
            safeForPublic: false,
        });
    });

    it("reads the two answers independently", () => {
        // The photo that this whole field exists for: a real dog, in a frame
        // that cannot go on the front page.
        expect(readScreening({ isDog: true, safeForPublic: false })).toEqual({
            isDog: true,
            safeForPublic: false,
        });
    });

    it("refuses a truthy value that is not the boolean", () => {
        // A model that answers with the STRING "false" would otherwise pass:
        // every non-empty string is truthy.
        expect(readScreening({ isDog: "false", safeForPublic: "false" }).isDog).toBe(false);
        expect(readScreening({ isDog: "true", safeForPublic: "true" }).safeForPublic).toBe(false);
        expect(readScreening({ isDog: 1, safeForPublic: 1 })).toEqual({
            isDog: false,
            safeForPublic: false,
        });
    });

    it("refuses anything that is not the expected shape", () => {
        // parseJson answers null for a non-JSON body; screenPhoto treats that as
        // a non-answer and decides both halves itself before this is ever asked,
        // but the narrowing must not read it as a yes either.
        for (const value of [null, undefined, {}, [], "isDog", true]) {
            expect(readScreening(value)).toEqual({ isDog: false, safeForPublic: false });
        }
    });

    it("refuses publication for an answer that omits the safety field", () => {
        // The half that must never fall open: an older or truncated response
        // that carries only isDog is not permission to publish.
        expect(readScreening({ isDog: true })).toEqual({ isDog: true, safeForPublic: false });
    });
});

/**
 * The retry loop nothing else can reach: generateCaseBible answers the fixture
 * under APP_ENV=test, so every paid call this bounds is invisible to the rest of
 * the suite.
 */
describe("generateValidated", () => {
    const schema = {
        type: Type.OBJECT,
        properties: { value: { type: Type.STRING } },
    } as const;
    // Accepts one exact answer, and says why for anything else - the shape of a
    // real validator, small enough to read.
    function onlyGood(value: unknown): ValidationResult<{ value: string }> {
        if (typeof value === "object" && value !== null && "value" in value) {
            return { ok: true, value: { value: String(value.value) } };
        }
        return { ok: false, errors: ["value is missing", "value must be a string"] };
    }

    beforeEach(() => {
        vi.mocked(generateJson).mockReset();
    });

    it("retries once with the reasons, and keeps the second answer", async () => {
        vi.mocked(generateJson)
            .mockResolvedValueOnce(JSON.stringify({ wrong: true }))
            .mockResolvedValueOnce(JSON.stringify({ value: "good" }));

        const result = await generateValidated("facts", "PROMPT", schema, onlyGood, {});

        expect(result).toStrictEqual({ value: "good" });
        expect(generateJson).toHaveBeenCalledTimes(2);
        // The feedback is the whole reason this is a loop rather than a retry: a
        // second roll of the dice would send the same prompt back unchanged.
        const [secondPrompt] = vi.mocked(generateJson).mock.calls[1] ?? [];
        expect(secondPrompt).toContain("PROMPT");
        expect(secondPrompt).toContain("value is missing");
        expect(secondPrompt).toContain("value must be a string");
    });

    it("stops after MAX_ATTEMPTS rather than calling until it converges", async () => {
        vi.mocked(generateJson).mockResolvedValue(JSON.stringify({ wrong: true }));

        await expect(generateValidated("facts", "PROMPT", schema, onlyGood, {})).rejects.toThrow(
            /failed validation 2 times/,
        );
        // The ceiling on what one stage can spend. A loop that kept going here
        // would bill per attempt with nothing capping the attempts.
        expect(generateJson).toHaveBeenCalledTimes(2);
    });

    it("treats a non-JSON response as a rejection rather than a value", async () => {
        vi.mocked(generateJson)
            .mockResolvedValueOnce("I'm sorry, I can't help with that.")
            .mockResolvedValueOnce(JSON.stringify({ value: "good" }));

        await expect(
            generateValidated("facts", "PROMPT", schema, onlyGood, {}),
        ).resolves.toStrictEqual({ value: "good" });
    });

    it("gives up immediately when the request itself is refused", async () => {
        vi.mocked(generateJson).mockRejectedValue(new Error("400 invalid schema"));

        await expect(generateValidated("tree", "PROMPT", schema, onlyGood, {})).rejects.toThrow(
            "400 invalid schema",
        );
        // Retrying a refused REQUEST just pays for the same refusal twice.
        expect(generateJson).toHaveBeenCalledTimes(1);
    });
});

/**
 * The memory bound on the dog check: every in-flight check holds the photo and
 * its base64 copy (~47MB for a 20MB upload) alive, and it runs before the
 * generation slot counter can see it.
 */
describe("dog check slots", () => {
    const held: number[] = [];

    afterEach(() => {
        delete process.env.DOG_CHECK_MAX_CONCURRENT;
        while (held.pop() !== undefined) {
            releaseDogCheckSlot();
        }
    });

    function hold(): boolean {
        const taken = acquireDogCheckSlot();
        if (taken) {
            held.push(1);
        }
        return taken;
    }

    it("hands out no more slots than the ceiling", () => {
        process.env.DOG_CHECK_MAX_CONCURRENT = "2";

        expect(hold()).toBe(true);
        expect(hold()).toBe(true);
        expect(dogCheckSlotsAvailable()).toBe(false);
        expect(hold()).toBe(false);
    });

    it("frees a slot again on release", () => {
        process.env.DOG_CHECK_MAX_CONCURRENT = "1";

        expect(hold()).toBe(true);
        expect(dogCheckSlotsAvailable()).toBe(false);

        releaseDogCheckSlot();
        held.pop();
        expect(dogCheckSlotsAvailable()).toBe(true);
    });

    // The counter is what the router's shed reads, so screenPhoto has to refuse
    // on the same condition rather than queueing another 19MB behind the ones
    // already running.
    it("refuses a screening when every slot is taken", async () => {
        process.env.DOG_CHECK_MAX_CONCURRENT = "1";
        expect(hold()).toBe(true);

        await expect(
            screenPhoto({ bytes: Buffer.from("photo"), mimeType: "image/png" }),
        ).rejects.toBeInstanceOf(DogCheckBusyError);
    });

    it("gives the slot back after a screening, however it went", async () => {
        process.env.DOG_CHECK_MAX_CONCURRENT = "1";

        await screenPhoto({ bytes: Buffer.from("photo"), mimeType: "image/png" });

        // A leak here shows up as the court reporting itself full forever.
        expect(dogCheckSlotsAvailable()).toBe(true);
    });
});

describe("renderEvidence", () => {
    beforeEach(() => {
        vi.mocked(generateImage).mockResolvedValue({
            bytes: Buffer.from("image bytes"),
            mimeType: "image/png",
        });
        vi.mocked(uploadExhibit).mockImplementation((_bytes, _type, prefix) =>
            Promise.resolve({
                url: `https://cdn.test/${prefix}/full.webp`,
                key: `${prefix}/full.webp`,
            }),
        );
        vi.mocked(uploadThumbnail).mockImplementation((_bytes, prefix) =>
            Promise.resolve({
                url: `https://cdn.test/${prefix}/thumb.webp`,
                key: `${prefix}/thumb.webp`,
            }),
        );
    });

    it("gives every exhibit a full image and a strip copy, and hands back both keys", async () => {
        const result = await renderEvidence([exhibit("E1")], photo, new AbortController().signal);

        expect(result.evidence[0]?.imageUrl).toBe("https://cdn.test/evidence/full.webp");
        expect(result.evidence[0]?.thumbUrl).toBe("https://cdn.test/evidence/thumb.webp");
        // Both, or the one left out is a paid object nothing can reclaim.
        expect(result.storedKeys).toStrictEqual(["evidence/full.webp", "evidence/thumb.webp"]);
    });

    it("keeps the exhibit when only the strip copy fails", async () => {
        vi.mocked(uploadThumbnail).mockResolvedValue(null);

        const result = await renderEvidence([exhibit("E1")], photo, new AbortController().signal);

        // A failed resize costs bytes on the strip, never the exhibit itself.
        expect(result.evidence[0]?.imageUrl).toBe("https://cdn.test/evidence/full.webp");
        expect(result.evidence[0]?.thumbUrl).toBeNull();
        expect(result.storedKeys).toStrictEqual(["evidence/full.webp"]);
    });

    it("leaves an exhibit pictureless when its image fails, and keeps the others", async () => {
        vi.mocked(generateImage)
            .mockRejectedValueOnce(new Error("model refused"))
            .mockResolvedValue({ bytes: Buffer.from("image bytes"), mimeType: "image/png" });

        const result = await renderEvidence(
            [exhibit("E1"), exhibit("E2")],
            photo,
            new AbortController().signal,
        );

        expect(result.evidence[0]?.imageUrl).toBeNull();
        expect(result.evidence[0]?.thumbUrl).toBeNull();
        expect(result.evidence[1]?.imageUrl).toBe("https://cdn.test/evidence/full.webp");
    });
});
