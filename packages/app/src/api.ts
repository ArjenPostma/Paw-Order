import type { PublicCase } from "@paw-order/shared";

// VITE_API_URL is build-time: empty in dev (the Vite proxy makes /api
// same-origin), the Railway api origin in the Cloudflare Pages build.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** Every network call goes through this — bare fetch("/api/...") 404s in prod. */
export function apiUrl(path: string): string {
    return `${BASE}${path}`;
}

async function readJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        // The api sends an actionable message ("max 8MB", "Case not found");
        // discarding it for a bare status code leaves the user nothing to fix.
        const body: unknown = await response.json().catch(() => null);
        const message =
            typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
        throw new Error(
            typeof message === "string" ? message : `Request failed (${response.status})`,
        );
    }
    return response.json();
}

export async function createCase(photo: File): Promise<PublicCase> {
    const body = new FormData();
    body.append("photo", photo);
    const response = await fetch(apiUrl("/api/cases"), { method: "POST", body });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as PublicCase;
}

export async function fetchCase(id: string): Promise<PublicCase> {
    const response = await fetch(apiUrl(`/api/cases/${id}`));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as PublicCase;
}
