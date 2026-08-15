import type { CaseAccepted, CaseStatusResponse, TurnResponse } from "@paw-order/shared";

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

/** Returns as soon as the case has an id. The case itself is still generating. */
export async function createCase(photo: File): Promise<CaseAccepted> {
    const body = new FormData();
    body.append("photo", photo);
    const response = await fetch(apiUrl("/api/cases"), { method: "POST", body });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as CaseAccepted;
}

export async function fetchCase(id: string): Promise<CaseStatusResponse> {
    const response = await fetch(apiUrl(`/api/cases/${id}`));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as CaseStatusResponse;
}

/**
 * Plays the run so far. `path` is every choice index taken from the opening
 * node onwards; the api holds the state and replays it, so the client sends the
 * whole path each turn rather than tracking a score it is not trusted with.
 */
export async function playTurn(id: string, path: number[]): Promise<TurnResponse> {
    const response = await fetch(apiUrl(`/api/cases/${id}/turn`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
    });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as TurnResponse;
}
