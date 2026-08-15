import { GoogleGenAI } from "@google/genai";
import type { Content, Part, Schema } from "@google/genai";
import { requireEnv } from "@/config/env";

// Model ids live in env so a rename upstream is a redeploy, not a code change -
// which is what happened to the 2.5 defaults these replace: Google retired them
// for new API keys, so every generation 404ed. Pinned rather than the moving
// `gemini-flash-latest` alias, because a silent model swap changes how the
// prompts behave and the validator is what pays for it.
//
// The -image model keeps a reference photo's subject consistent across generated
// exhibits, which is the whole trick behind the evidence images. -lite is the
// cheap tier, roughly half the per-image price of gemini-3.1-flash-image. If the
// defendant stops looking like the uploaded dog, that likeness is worth more than
// the saving: trade back up with GEMINI_IMAGE_MODEL rather than editing this.
//
// Both exported so a failure log can name the model that actually ran, rather
// than whichever id the reader assumes is configured.
export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-3.7-flash";
export const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-lite-image";
/**
 * Image size is the single biggest cost lever in the whole app: exhibits are
 * three of the four paid calls per case. On the lite model above the tiers are
 * roughly 1K $0.034, 2K $0.05, 4K $0.076 each (double those on
 * gemini-3.1-flash-image). Pinned rather than left to the model's default,
 * because that default is not ours to rely on. 1K is 1024px, far more than the
 * exhibits are ever displayed at.
 *
 * The tiers are per model, and the allowlist below cannot know which model is
 * configured: the -lite default accepts ONLY 1K, and asking it for 2K comes back
 * 400 "Image size 2K is not supported for this model" on every exhibit, after
 * the text stage has already been paid for. Raise GEMINI_IMAGE_MODEL first, then
 * GEMINI_IMAGE_SIZE. Neither buys legibility on its own - a detail renders
 * because the prompt puts it close to the camera, which is what case_prompt.ts
 * asks for.
 */
const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
const IMAGE_SIZE = resolveImageSize();

/**
 * Allowlisted, because the field is typed `string` in the SDK: a lowercase
 * "1k" or a "1024" typechecks, reaches the endpoint, and 400s every image call
 * - which fails the whole case AFTER the text stage has already been billed.
 * Same warn-and-fall-back shape as positiveIntEnv, for the same reason.
 */
function resolveImageSize(): string {
    const raw = process.env.GEMINI_IMAGE_SIZE;
    if (raw === undefined || raw === "") {
        return "1K";
    }
    if (IMAGE_SIZES.some((size) => size === raw)) {
        return raw;
    }
    console.warn(
        `[paw-order-api] GEMINI_IMAGE_SIZE=${JSON.stringify(raw)} is not one of ${IMAGE_SIZES.join(", ")}, falling back to 1K`,
    );
    return "1K";
}
// ~12MB of base64, i.e. ~9MB of image. Well above any exhibit this game needs.
const MAX_IMAGE_BASE64_CHARS = 12 * 1024 * 1024;

let client: GoogleGenAI | null = null;

/** Lazy so the api boots (and /health answers) without a key present. */
function getClient(): GoogleGenAI {
    if (!client) {
        client = new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });
    }
    return client;
}

export interface GeneratedImage {
    bytes: Buffer;
    mimeType: string;
}

/**
 * A photo already encoded for the wire. One generation sends the same reference
 * photo to four calls, three of them concurrent, and `toString("base64")` on an
 * 8MB buffer allocates ~10.7MB every time - so encoding per call held three
 * independent copies of the same bytes alive at once. Encode once, pass this.
 */
export interface EncodedImage {
    base64: string;
    mimeType: string;
}

export function encodeImage(image: GeneratedImage): EncodedImage {
    return { base64: image.bytes.toString("base64"), mimeType: image.mimeType };
}

/**
 * One user turn, with the reference photo first when there is one. Order
 * matters: the image has to precede the text that talks about it.
 */
function userContent(prompt: string, reference?: EncodedImage): Content[] {
    const parts: Part[] = [];
    if (reference) {
        parts.push({
            inlineData: { mimeType: reference.mimeType, data: reference.base64 },
        });
    }
    parts.push({ text: prompt });
    return [{ role: "user", parts }];
}

export interface GenerateOptions {
    /** The player's dog photo, when the model needs to see it. */
    reference?: EncodedImage;
    /** Aborts a hung call. Note: billing still applies to whatever ran. */
    signal?: AbortSignal;
}

/**
 * Generates JSON constrained to `responseSchema`. Returns the raw text; the
 * caller validates it — a schema-constrained model is still a network peer,
 * not a guarantee.
 */
export async function generateJson(
    prompt: string,
    responseSchema: Schema,
    options: GenerateOptions = {},
): Promise<string> {
    const response = await getClient().models.generateContent({
        model: TEXT_MODEL,
        contents: userContent(prompt, options.reference),
        config: {
            responseMimeType: "application/json",
            responseSchema,
            abortSignal: options.signal,
        },
    });

    const text = response.text;
    if (!text) {
        throw new Error("Gemini returned no text");
    }
    return text;
}

/**
 * Generates one evidence image. `reference` is the player's dog photo, passed
 * inline so the same dog appears in every exhibit (gamedesign.md §5).
 */
export async function generateImage(
    prompt: string,
    reference: EncodedImage,
    signal?: AbortSignal,
): Promise<GeneratedImage> {
    const response = await getClient().models.generateContent({
        model: IMAGE_MODEL,
        contents: userContent(prompt, reference),
        config: {
            responseModalities: ["IMAGE"],
            // Square because every surface that renders an exhibit is square or
            // near it - the mugshot is a 224px square and the strip tiles are
            // fixed-width - so a landscape frame is cropped or letterboxed at
            // every size the player ever sees it.
            imageConfig: { imageSize: IMAGE_SIZE, aspectRatio: "1:1" },
            abortSignal: signal,
        },
    });

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data) {
            // Bounds the Buffer.from allocation only. The SDK has already
            // received and JSON-parsed the whole response by this point, so a
            // 200MB part is in memory either way - this stops it being decoded
            // into a second, larger copy. A real bound belongs at the transport.
            if (data.length > MAX_IMAGE_BASE64_CHARS) {
                throw new Error("Gemini returned an image larger than the allowed size");
            }
            return {
                bytes: Buffer.from(data, "base64"),
                mimeType: part.inlineData?.mimeType ?? "image/png",
            };
        }
    }

    throw new Error("Gemini returned no image data");
}
