import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { requireEnv, resolveAppEnv } from "@/config/env";

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

/**
 * Uploads bytes under `prefix/<uuid>` and returns the public URL.
 * R2_PUBLIC_URL is the bucket's public (or custom) domain — the bucket itself
 * stays private to the api's credentials for writes.
 */
export async function uploadImage(
    bytes: Buffer,
    contentType: string,
    prefix: string,
): Promise<string> {
    const extension = contentType === "image/png" ? "png" : "jpg";
    const key = `${prefix}/${randomUUID()}.${extension}`;

    if (resolveAppEnv() !== "production" && !process.env.R2_BUCKET) {
        // Dev without R2 configured: hand back a data URL so the pipeline runs
        // end to end locally. Never taken in production (env is asserted at boot).
        return `data:${contentType};base64,${bytes.toString("base64")}`;
    }

    await getClient().send(
        new PutObjectCommand({
            Bucket: requireEnv("R2_BUCKET"),
            Key: key,
            Body: bytes,
            ContentType: contentType,
        }),
    );

    return `${requireEnv("R2_PUBLIC_URL").replace(/\/+$/, "")}/${key}`;
}
