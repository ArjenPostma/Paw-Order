import type { CaseAccepted, CaseStatusResponse, TurnResponse } from "@paw-order/shared";

// VITE_API_URL is build-time: empty in dev (the Vite proxy makes /api
// same-origin), the Railway api origin in the Cloudflare Pages build.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** Every network call goes through this — bare fetch("/api/...") 404s in prod. */
export function apiUrl(path: string): string {
    return `${BASE}${path}`;
}

/**
 * A turn is a primary-key read and a replay of a path the client already holds,
 * so it is fast or it is broken. Without a deadline a stalled connection leaves
 * the courtroom with every choice disabled and no error to explain it.
 */
const TURN_TIMEOUT_MS = 15000;
/**
 * A case read is a primary-key lookup, so it is fast or it is broken - same
 * reasoning as the turn deadline above. It bounds one poll attempt, not the poll
 * loop, which has its own attempt and consecutive-failure ceilings.
 */
const FETCH_TIMEOUT_MS = 15000;

/**
 * Carries the status alongside the message. A caller that has to tell "this case
 * is gone for good" from "the network blinked" was otherwise left matching on
 * the api's own user-facing copy, which quietly stops working when that copy is
 * reworded.
 */
export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

async function readJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        // The api sends an actionable message ("max 8MB", "Case not found");
        // discarding it for a bare status code leaves the user nothing to fix.
        const body: unknown = await response.json().catch(() => null);
        const message =
            typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
        const text = typeof message === "string" ? message : `Request failed (${response.status})`;
        // The limiter already computes how long the wait is; saying "shortly"
        // and dropping the number leaves the player guessing whether to retry
        // now or give up. Seconds, because the window is a minute.
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
            throw new ApiError(
                `${text} Another case can be opened in ${String(retryAfter)}s.`,
                response.status,
            );
        }
        throw new ApiError(text, response.status);
    }
    return response.json();
}

/** Returns as soon as the case has an id. The case itself is still generating. */
export async function createCase(photo: File, name: string): Promise<CaseAccepted> {
    const body = new FormData();
    // Before the photo, which is the order multer's own docs ask for: a field
    // that arrives after the file is not guaranteed to be on req.body while the
    // file is being handled. Omitted entirely when blank - the api defaults it.
    if (name) {
        body.append("name", name);
    }
    body.append("photo", photo);
    const response = await fetch(apiUrl("/api/cases"), { method: "POST", body });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as CaseAccepted;
}

/**
 * `fresh` revalidates instead of reading the browser's own cache. A READY case
 * answers `immutable, max-age=31536000`, which is right for the poll loop and
 * wrong for replay: a case the api has since dropped would be served from disk
 * forever, so the tile could never be found dead and removed.
 */
export async function fetchCase(id: string, fresh = false): Promise<CaseStatusResponse> {
    let response;
    try {
        response = await fetch(apiUrl(`/api/cases/${id}`), {
            cache: fresh ? "no-cache" : "default",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    } catch {
        // Includes the timeout. Without a deadline a stalled connection leaves
        // the player on a screen that never changes and never explains itself.
        throw new Error("The clerk did not come back. Try that again.");
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as CaseStatusResponse;
}

/**
 * Plays the run so far. `path` is every choice index taken from the opening
 * node onwards; the api holds the state and replays it, so the client sends the
 * whole path each turn rather than tracking a score it is not trusted with.
 */
export async function playTurn(id: string, path: number[]): Promise<TurnResponse> {
    let response;
    try {
        response = await fetch(apiUrl(`/api/cases/${id}/turn`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
            signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        });
    } catch {
        // Includes the timeout above. The DOMException reads "signal timed out",
        // which is not something to show a player mid-trial.
        throw new Error("The court did not respond. Try that again.");
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as TurnResponse;
}
