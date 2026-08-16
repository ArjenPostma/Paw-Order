import type {
    CaseAccepted,
    CaseStatusResponse,
    PublicCaseSummary,
    TurnResponse,
} from "@paw-order/shared";

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

/**
 * Retry-After in words. The per-minute limiter and the per-day one share this
 * header, so a raw second count read fine for the first ("in 42s") and absurd
 * for the second, which sent the player "Another case can be opened in 86400s."
 */
function waitFor(seconds: number): string {
    if (seconds < 90) {
        return `Another case can be opened in ${String(Math.ceil(seconds))}s.`;
    }
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 90) {
        return `Another case can be opened in ${String(minutes)} minutes.`;
    }
    const hours = Math.ceil(minutes / 60);
    return `Another case can be opened in ${String(hours)} hours.`;
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
        // now or give up.
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
            throw new ApiError(`${text} ${waitFor(retryAfter)}`, response.status);
        }
        throw new ApiError(text, response.status);
    }
    return response.json();
}

/**
 * Returns as soon as the case has an id. The case itself is still generating.
 *
 * `honeypot` is whatever was in the upload screen's hidden field: empty for a
 * person, since they never see it. The api refuses an upload that carries it.
 */
export async function createCase(
    photo: File,
    name: string,
    isPublic: boolean,
    honeypot: string,
): Promise<CaseAccepted> {
    const body = new FormData();
    // Sent only when filled, so an ordinary upload still carries three text
    // fields at most - the api's multer limits count these exactly.
    if (honeypot) {
        body.append("website", honeypot);
    }
    // Milliseconds this page has been open. performance.now() is monotonic and
    // starts at navigation, so a wrong system clock cannot make it absurd and
    // nothing here depends on agreeing with the server's clock. The api refuses
    // an upload that arrives faster than a person could have picked a photo.
    body.append("dwell", String(Math.round(performance.now())));
    // Before the photo, which is the order multer's own docs ask for: a field
    // that arrives after the file is not guaranteed to be on req.body while the
    // file is being handled. Omitted entirely when blank - the api defaults it.
    if (name) {
        body.append("name", name);
    }
    // Sent only when ticked, for the same reason: an absent field is the api's
    // default, and a case is private unless the player said otherwise. The
    // api's multer limits count these - two text fields, no more.
    if (isPublic) {
        body.append("public", "true");
    }
    body.append("photo", photo);
    const response = await fetch(apiUrl("/api/cases"), { method: "POST", body });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as CaseAccepted;
}

/** Both case reads. An id and a link answer the same body from the same code. */
async function getCase(path: string, fresh: boolean): Promise<CaseStatusResponse> {
    let response;
    try {
        response = await fetch(apiUrl(path), {
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
 * `fresh` revalidates instead of reading the browser's own cache. A READY case
 * answers `immutable, max-age=31536000`, which is right for the poll loop and
 * wrong for replay: a case the api has since dropped would be served from disk
 * forever, so the tile could never be found dead and removed.
 */
export function fetchCase(id: string, fresh = false): Promise<CaseStatusResponse> {
    return getCase(`/api/cases/${id}`, fresh);
}

/**
 * The case behind a shared link. Always revalidated, for the same reason a
 * replay is: this is the first thing a visitor following someone else's link
 * sees, and a year-old cached copy of a case that has since been deleted would
 * open a courtroom whose images 404.
 */
export function fetchCaseBySlug(slug: string): Promise<CaseStatusResponse> {
    return getCase(`/api/cases/link/${encodeURIComponent(slug)}`, true);
}

/**
 * The public docket. A strip on the home page, so a failure here is not worth
 * a message: the caller drops the section rather than telling a player that a
 * list they did not ask for did not load.
 */
export async function fetchPublicCases(): Promise<PublicCaseSummary[]> {
    const response = await fetch(apiUrl("/api/cases/public"), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- serialization boundary
    return (await readJson(response)) as PublicCaseSummary[];
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
