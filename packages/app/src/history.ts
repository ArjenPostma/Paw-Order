/**
 * The player's own case file, kept in localStorage. A case is anonymous - the
 * api hands out an id and never asks who is holding it - so this list is the
 * only way back to a case once the tab is closed, and it never leaves the
 * browser. Replaying one costs no generation, which is why it is worth keeping.
 */

const STORAGE_KEY = "paw-order.cases";
/** A strip along the bottom of the home page, not an archive. */
const MAX_ENTRIES = 6;

export interface PlayedCase {
    id: string;
    name: string;
    title: string;
    charge: string;
    photoUrl: string;
}

/**
 * localStorage is absent in a few real browsers (Safari's lockdown modes, an
 * iframe with storage blocked) and throws on write when the quota is full. The
 * strip is a convenience, so every failure here is silent: a player who cannot
 * store history can still play.
 */
function read(): unknown {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw === null ? null : JSON.parse(raw);
    } catch {
        return null;
    }
}

/** Written by an older build, hand-edited, or corrupted: check every field. */
function isPlayedCase(value: unknown): value is PlayedCase {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    return (
        "id" in value &&
        typeof value.id === "string" &&
        "name" in value &&
        typeof value.name === "string" &&
        "title" in value &&
        typeof value.title === "string" &&
        "charge" in value &&
        typeof value.charge === "string" &&
        "photoUrl" in value &&
        typeof value.photoUrl === "string"
    );
}

export function playedCases(): PlayedCase[] {
    const stored = read();
    if (!Array.isArray(stored)) {
        return [];
    }
    return stored.filter(isPlayedCase).slice(0, MAX_ENTRIES);
}

/**
 * Newest first, one entry per case: replaying an old case moves it back up.
 *
 * The photo is dropped when it is a data: URL. The api falls back to inlining
 * the bytes when R2_BUCKET is unset (r2.ts), which is the documented local
 * setup, and an 8MB upload inlines to an ~11MB string - one of those blows the
 * ~5MB quota, and from then on every write here throws and is swallowed, so the
 * strip silently stops updating and a dead tile can never be dropped either. The
 * tile renders its placard without a photo instead.
 */
export function rememberCase(played: PlayedCase): void {
    const kept = playedCases().filter((entry) => entry.id !== played.id);
    const entry = played.photoUrl.startsWith("data:") ? { ...played, photoUrl: "" } : played;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...kept].slice(0, MAX_ENTRIES)));
    } catch {
        // Full or unavailable. Nothing to do and nothing to tell the player.
    }
}

/** Drops a case the api no longer serves, so a dead tile cannot be clicked twice. */
export function forgetCase(id: string): void {
    const kept = playedCases().filter((entry) => entry.id !== id);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch {
        // Same as above.
    }
}
