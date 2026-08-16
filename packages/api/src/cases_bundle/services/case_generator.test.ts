import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Evidence } from "@paw-order/shared";
import { readScreening, renderEvidence } from "@/cases_bundle/services/case_generator";
import { uploadExhibit, uploadThumbnail } from "@/storage/r2";
import { generateImage } from "@/ai/gemini";

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
