import type { CaseBible } from "@paw-order/shared";
import type { GeneratedImage } from "@/ai/gemini";

/**
 * The generation seam: photo in, complete Case Bible out. Everything downstream
 * (persistence, the trial engine, the verdict) reads only this return value, so
 * the real generator can land here without touching the rest of the api.
 *
 * ponytail: placeholder bible — no Gemini calls yet, so upload/persist/serve can
 * be verified end to end first. Replace the body with the two-step pipeline
 * (generateJson for the bible -> generateImage per exhibit -> uploadImage) when
 * the prompts are written.
 */
export async function generateCaseBible(
    photoUrl: string,
    _photo: GeneratedImage,
): Promise<CaseBible> {
    return {
        defendant: { name: "Unnamed", photoUrl },
        crime: {
            charge: "Pending investigation",
            title: "Untitled Case",
            location: "Unknown",
            timeline: [],
        },
        truth: { summary: "Not yet generated.", misleadingEvidenceIds: [] },
        evidence: [],
        witnesses: [],
        nodes: [],
        rootNodeId: "",
        verdictRules: { acquitAtDoubt: 60, suspiciousAtSuspicion: 50 },
    };
}
