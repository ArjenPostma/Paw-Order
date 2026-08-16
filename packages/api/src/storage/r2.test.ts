import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Metadata } from "sharp";
import { uploadExhibit, uploadThumbnail } from "@/storage/r2";

/**
 * Under APP_ENV=test uploadImage writes nothing and answers a data URL, so these
 * read the resize straight back out of the returned URL - no bucket, no mock.
 */
async function decode(url: string): Promise<Metadata> {
    const base64 = url.slice(url.indexOf(",") + 1);
    return sharp(Buffer.from(base64, "base64")).metadata();
}

async function png(width: number, height: number): Promise<Buffer> {
    return sharp({
        create: { width, height, channels: 3, background: { r: 200, g: 180, b: 120 } },
    })
        .png()
        .toBuffer();
}

/** Shaped like what the image model returns: 1024px jpeg, quality left high. */
async function jpeg(): Promise<Buffer> {
    return sharp({
        create: {
            width: 1024,
            height: 1024,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
            noise: { type: "gaussian", mean: 128, sigma: 30 },
        },
    })
        .jpeg({ quality: 100 })
        .toBuffer();
}

describe("uploadExhibit", () => {
    it("stores the exhibit as webp, smaller than what the model returned", async () => {
        const original = await jpeg();

        const stored = await uploadExhibit(original, "image/jpeg", "evidence");

        const metadata = await decode(stored.url);
        expect(metadata.format).toBe("webp");
        expect(metadata.width).toBe(1024);
        expect(metadata.size).toBeLessThan(original.length);
    });

    it("stores what the model returned when the re-encode cannot read the bytes", async () => {
        const stored = await uploadExhibit(Buffer.from("not an image"), "image/png", "evidence");

        expect(stored.url.startsWith("data:image/png;base64,")).toBe(true);
    });
});

describe("uploadThumbnail", () => {
    it("resizes a full exhibit down to the strip width as webp", async () => {
        const stored = await uploadThumbnail(await png(1024, 1024), "evidence");

        expect(stored).not.toBeNull();
        const metadata = await decode(stored?.url ?? "");
        expect(metadata.format).toBe("webp");
        expect(metadata.width).toBe(432);
    });

    it("leaves an image already narrower than the strip at its own width", async () => {
        const stored = await uploadThumbnail(await png(200, 200), "evidence");

        const metadata = await decode(stored?.url ?? "");
        expect(metadata.width).toBe(200);
    });

    it("answers null rather than throwing when the bytes are not an image", async () => {
        expect(await uploadThumbnail(Buffer.from("not an image"), "evidence")).toBeNull();
    });
});
