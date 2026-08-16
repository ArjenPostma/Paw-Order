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
 * Quality of the stored exhibit. Measured against real generated exhibits: the
 * image model returns 1024px jpeg at near-lossless quality, ~450-700KB, and this
 * lands the same frame at 19-127KB - roughly an eighth - for a mean per-channel
 * error of under 2/255. The lightbox is where a player reads a clock face or a
 * label, so the fidelity is the point, not the bytes; 82 was picked because the
 * error at 90 was not measurably better on the same images.
 */
const EXHIBIT_QUALITY = 82;

/**
 * Stores an exhibit, re-encoded to webp when that comes out smaller.
 *
 * The size is a page-load number more than a storage one - a case is four to six
 * exhibits, and the lightbox opens the full frame.
 *
 * A re-encode that throws stores what the model returned instead: an exhibit with
 * a big image is worth more than no exhibit. The upload itself is deliberately
 * outside that catch, so a failed PUT stays a failure rather than retrying with
 * different bytes.
 */
export async function uploadExhibit(
    bytes: Buffer,
    contentType: string,
    prefix: string,
    signal?: AbortSignal,
): Promise<StoredImage> {
    let body = { bytes, contentType };
    try {
        const webp = await sharp(bytes).webp({ quality: EXHIBIT_QUALITY }).toBuffer();
        if (webp.length < bytes.length) {
            body = { bytes: webp, contentType: "image/webp" };
        }
    } catch (error: unknown) {
        console.error(
            "[paw-order-api] exhibit re-encode failed; storing what the model returned",
            error,
        );
    }
    return uploadImage(body.bytes, body.contentType, prefix, signal);
}

/** Thrown when the uploaded bytes are not an image anything can decode. */
export class UnreadableImageError extends Error {
    constructor(cause: unknown) {
        super("The uploaded photo could not be decoded as an image.", { cause });
    }
}

/**
 * Stores the player's own photo, re-encoded from the decoded pixels.
 *
 * The one upload whose bytes come from the caller rather than from the image
 * model, and the only thing standing between them and an object served from a
 * public domain the operator owns. The mime allowlist upstream reads a string
 * the caller chose; the dog check is a model asking what is in the picture, not
 * a decoder. So decode it here and store what came out: a file carrying anything
 * besides an image loses it, and the EXIF block - orientation, camera, and the
 * GPS coordinates of somebody's garden - does not reach the bucket either.
 *
 * Fails CLOSED, unlike uploadExhibit: bytes that will not decode are not a photo
 * with a poor re-encode, they are the case this exists to refuse. The router
 * answers 400.
 */
export async function uploadDogPhoto(
    bytes: Buffer,
    prefix: string,
    signal?: AbortSignal,
): Promise<StoredImage> {
    let encoded: Buffer;
    try {
        // rotate() before the encode, with no argument: it applies whatever the
        // EXIF orientation said and then drops it. Without it the metadata that
        // was holding a phone photo upright is stripped along with the rest and
        // every such mugshot arrives on its side.
        encoded = await sharp(bytes).rotate().webp({ quality: EXHIBIT_QUALITY }).toBuffer();
    } catch (error: unknown) {
        throw new UnreadableImageError(error);
    }
    return uploadImage(encoded, "image/webp", prefix, signal);
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
