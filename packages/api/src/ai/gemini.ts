import { GoogleGenAI } from "@google/genai";
import { requireEnv } from "@/config/env";

// Model ids live in env so a rename upstream is a redeploy, not a code change.
// Nano Banana (the -image model) is the cheap tier and is the one that keeps a
// reference photo's subject consistent across generated exhibits.
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";

let client: GoogleGenAI | null = null;

/** Lazy so the api boots (and /health answers) without a key present. */
function getClient(): GoogleGenAI {
    if (!client) {
        client = new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });
    }
    return client;
}

/**
 * Generates JSON constrained to `responseSchema` (a Gemini response schema).
 * Returns the raw text; the caller validates it — a schema-constrained model is
 * still a network peer, not a guarantee.
 */
export async function generateJson(prompt: string, responseSchema: object): Promise<string> {
    const response = await getClient().models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema,
        },
    });

    const text = response.text;
    if (!text) {
        throw new Error("Gemini returned no text");
    }
    return text;
}

export interface GeneratedImage {
    bytes: Buffer;
    mimeType: string;
}

/**
 * Generates one evidence image. `reference` is the player's dog photo, passed
 * inline so the same dog appears in every exhibit (gamedesign.md §5).
 */
export async function generateImage(
    prompt: string,
    reference: GeneratedImage,
): Promise<GeneratedImage> {
    const response = await getClient().models.generateContent({
        model: IMAGE_MODEL,
        contents: [
            {
                role: "user",
                parts: [
                    {
                        inlineData: {
                            mimeType: reference.mimeType,
                            data: reference.bytes.toString("base64"),
                        },
                    },
                    { text: prompt },
                ],
            },
        ],
        config: { responseModalities: ["IMAGE"] },
    });

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data) {
            return {
                bytes: Buffer.from(data, "base64"),
                mimeType: part.inlineData?.mimeType ?? "image/png",
            };
        }
    }

    throw new Error("Gemini returned no image data");
}
