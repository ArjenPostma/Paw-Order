import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Metadata } from "sharp";
import { uploadThumbnail } from "@/storage/r2";

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
