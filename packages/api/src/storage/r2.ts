import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { requireEnv, resolveAppEnv } from "@/config/env";

/**
 * The only content types this bucket ever stores, and the extension each one
 * gets. One map so the two can never disagree - deriving the extension
 * separately stored webp uploads under a .jpg key.
 */
const STORABLE_TYPES = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
]);

let client: S3Client | null = null;

/**
 * R2 speaks the S3 API. Lazy so dev boots without R2 credentials; the first
 * upload is what needs them.
 */
function getClient(): S3Client {
    if (!client) {
        client = new S3Client({
            region: "auto",
            endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
                secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
            },
        });
    }
    return client;
}

export interface StoredImage {
    /** Public URL, or a data URL when the local fallback ran. */
    url: string;
    /** Object key, or null when nothing was written to the bucket. */
    key: string | null;
}

/**
 * Uploads bytes under `prefix/<uuid>.<ext>` and returns the public URL plus the
 * key, so a caller that fails afterwards can delete what it wrote.
 */
export async function uploadImage(
    bytes: Buffer,
    contentType: string,
    prefix: string,
    signal?: AbortSignal,
): Promise<StoredImage> {
    const extension = STORABLE_TYPES.get(contentType);
    if (!extension) {
        // The caller's allowlist should have caught this; a bucket on a public
        // domain must never serve a type we did not choose.
        throw new Error(`Refusing to store unsupported content type: ${contentType}`);
    }

    const env = resolveAppEnv();
    // Tests NEVER write to a real bucket, even when packages/api/.env has R2
    // configured - data_source.ts loads that file during the test run, so a
    // `!R2_BUCKET` check alone would send test uploads to production. Dev
    // without R2 configured gets a data URL so the pipeline runs end to end
    // locally. Production is neither branch (env is asserted at boot).
    if (env === "test" || (env === "development" && !process.env.R2_BUCKET)) {
        return { url: `data:${contentType};base64,${bytes.toString("base64")}`, key: null };
    }

    const key = `${prefix}/${randomUUID()}.${extension}`;
    // The signal matters more than it looks: the S3 client resolves to no
    // request, connection or socket timeout at all, so without it a half-open
    // connection to R2 is bounded only by OS keepalive - minutes during which
    // the generation never settles and its concurrency slot is never released.
    await getClient().send(
        new PutObjectCommand({
            Bucket: requireEnv("R2_BUCKET"),
            Key: key,
            Body: bytes,
            ContentType: contentType,
            // The key carries a fresh uuid, so these bytes are immutable by
            // construction. Without this the browser falls back to heuristic
            // freshness - 10% of an object's age, which is ~0 for one written
            // seconds ago - and re-downloads every dog photo and exhibit on each
            // render instead of answering from its own cache.
            CacheControl: "public, max-age=31536000, immutable",
        }),
        { abortSignal: signal },
    );

    return { url: `${requireEnv("R2_PUBLIC_URL").replace(/\/+$/, "")}/${key}`, key };
}

/**
 * Width of the strip copy: the courtroom paints a 216px tile, doubled so it
 * stays sharp on a 2x screen. The full exhibit is still what the lightbox opens.
 */
const THUMBNAIL_WIDTH = 432;

/**
 * Writes a strip-sized webp beside an exhibit and returns it, or null.
 *
 * Never throws. A missing thumbnail costs bytes on the strip; a thrown one would
 * fail an exhibit that has a perfectly good image, and the caller treats a
 * failed exhibit as pictureless.
 */
export async function uploadThumbnail(
    bytes: Buffer,
    prefix: string,
    signal?: AbortSignal,
): Promise<StoredImage | null> {
    try {
        const resized = await sharp(bytes)
            // withoutEnlargement so an image that arrives smaller than the tile
            // is re-encoded rather than upscaled into a bigger file than the
            // original it is meant to save.
            .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
        return await uploadImage(resized, "image/webp", prefix, signal);
    } catch (error: unknown) {
        console.error(
            "[paw-order-api] thumbnail failed; the strip falls back to the full image",
            error,
        );
        return null;
    }
}

/**
 * Best-effort cleanup for an object whose owning row never got written. Never
 * throws: the caller is already handling a failure and must not lose it.
 */
export async function deleteImage(key: string | null): Promise<void> {
    if (!key) {
        return;
    }
    try {
        await getClient().send(
            new DeleteObjectCommand({ Bucket: requireEnv("R2_BUCKET"), Key: key }),
        );
    } catch (error: unknown) {
        console.error("[paw-order-api] failed to delete orphaned object", key, error);
    }
}
