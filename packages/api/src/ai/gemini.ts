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
 * four of the five paid calls per case, and the tiers are roughly 1K $0.067,
 * 2K $0.101, 4K $0.15 each. Pinned rather than left to the model's default,
 * because that default is not ours to rely on and an unpinned 2K quietly costs
 * half again as much per case. 1K is 1024px, far more than the exhibits are
 * ever displayed at.
 */
const IMAGE_SIZE = process.env.GEMINI_IMAGE_SIZE ?? "1K";
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
 * One user turn, with the reference photo first when there is one. Order
 * matters: the image has to precede the text that talks about it.
 */
function userContent(prompt: string, reference?: GeneratedImage): Content[] {
    const parts: Part[] = [];
    if (reference) {
        parts.push({
            inlineData: {
                mimeType: reference.mimeType,
                data: reference.bytes.toString("base64"),
            },
        });
    }
    parts.push({ text: prompt });
    return [{ role: "user", parts }];
}

export interface GenerateOptions {
    /** The player's dog photo, when the model needs to see it. */
    reference?: GeneratedImage;
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
    reference: GeneratedImage,
    signal?: AbortSignal,
): Promise<GeneratedImage> {
    const response = await getClient().models.generateContent({
        model: IMAGE_MODEL,
        contents: userContent(prompt, reference),
        config: {
            responseModalities: ["IMAGE"],
            imageConfig: { imageSize: IMAGE_SIZE },
            abortSignal: signal,
        },
    });

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data) {
            // Response size is the peer's choice, so bound it before allocating:
            // a malfunctioning upstream returning a 200MB part would otherwise be
            // buffered whole, once per exhibit.
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
