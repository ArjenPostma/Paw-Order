/**
 * The Case Bible: everything the generator produces up front, and the only
 * source of truth the trial engine reads from. Persisted as one jsonb column.
 */

export interface Defendant {
    /** Dog's name, invented by the generator. */
    name: string;
    /** R2 URL of the uploaded reference photo. */
    photoUrl: string;
}

export interface Crime {
    /** Docket-style charge, e.g. "Grand Theft Birthday Cake". */
    charge: string;
    /** Case title, e.g. "The Great Birthday Cake Heist". */
    title: string;
    location: string;
    /** "14:00 - Cake placed on counter" */
    timeline: string[];
}

/** Hidden until the verdict screen. Never sent to the client mid-trial. */
export interface Truth {
    summary: string;
    /** Ids of evidence that actually misleads, if any. */
    misleadingEvidenceIds: string[];
}

export interface Evidence {
    /** "E1" */
    id: string;
    label: string;
    /** Prompt the image generator was given, kept for regeneration. */
    imagePrompt: string;
    /** R2 URL, null until the image job completes. */
    imageUrl: string | null;
    /**
     * What is actually visible in the image. The trial may only reference
     * these; it must never invent a visual claim (gamedesign.md §13).
     */
    visualFacts: string[];
}

export interface Witness {
    id: string;
    name: string;
    claim: string;
    /**
     * Set by the generator; drives contradiction scoring. Truth-derived, so it
     * is stripped from PublicWitness - a client that can read which witness is
     * lying has been handed the answer (gamedesign.md §8 lists "the witness is
     * lying" as one of the hidden truths).
     */
    reliable: boolean;
}

/** A witness as the courtroom sees one: the claim, not whether it is true. */
export type PublicWitness = Omit<Witness, "reliable">;

/**
 * An exhibit as the courtroom sees one. `imagePrompt` is kept server-side for
 * regeneration; nothing renders it, and it is model prose from the same call
 * that wrote the hidden truth, so it has no business on the wire.
 */
export type PublicEvidence = Omit<Evidence, "imagePrompt">;

/** State deltas applied when a choice is taken. Negative values allowed. */
export interface GameEffects {
    doubt: number;
    credibility: number;
    suspicion: number;
    revealsEvidenceIds: string[];
}

export interface Choice {
    text: string;
    effects: GameEffects;
    /** null ends the trial and sends the player to the verdict. */
    nextNodeId: string | null;
}

export interface TrialNode {
    id: string;
    speaker: "PROSECUTOR" | "JUDGE" | "WITNESS";
    statement: string;
    /** Exhibits shown alongside the statement. */
    evidenceIds: string[];
    choices: Choice[];
}

export interface VerdictRules {
    /** Doubt at or above this acquits. */
    acquitAtDoubt: number;
    /** Suspicion at or above this taints an acquittal. */
    suspiciousAtSuspicion: number;
}

export const VERDICTS = [
    "NOT_GUILTY",
    "NOT_GUILTY_BUT_SUSPICIOUS",
    "GUILTY_BUT_REASONABLE_DOUBT",
    "GUILTY",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface CaseBible {
    defendant: Defendant;
    crime: Crime;
    truth: Truth;
    evidence: Evidence[];
    witnesses: Witness[];
    nodes: TrialNode[];
    rootNodeId: string;
    verdictRules: VerdictRules;
}

/**
 * What the client is allowed to see while the trial is running.
 *
 * `truth?: never` is load-bearing: a plain Omit is structurally satisfied by a
 * value that still carries truth (an object spread suppresses excess-property
 * checking), so `return { id, ...bible }` would typecheck and ship the answer.
 * With never, Truth is not assignable and that regression is a compile error.
 */
export type PublicCase = Omit<CaseBible, "truth" | "witnesses" | "evidence"> & {
    id: string;
    truth?: never;
    /** Narrowed, not inherited: see PublicWitness and PublicEvidence. */
    witnesses: PublicWitness[];
    evidence: PublicEvidence[];
};

export const CASE_STATUSES = ["PENDING", "READY", "FAILED"] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

/** What POST /api/cases answers: the case does not exist yet, only its id. */
export interface CaseAccepted {
    id: string;
    status: CaseStatus;
}

/**
 * What GET /api/cases/:id answers. Generation is asynchronous (a bible plus
 * its exhibit images runs far past any edge timeout), so the client polls this.
 * Only the READY arm carries the case, which is what stops a half-generated
 * bible — empty nodes, no rootNodeId — from ever reaching a courtroom.
 */
export type CaseStatusResponse =
    // `truth?: never` on this arm too, for the same reason it is on PublicCase:
    // without it, a future `return { id, status, ...entity.bible }` on the
    // not-yet-ready path typechecks and ships the answer on every poll.
    | { id: string; status: "PENDING" | "FAILED"; truth?: never }
    | ({ status: "READY" } & PublicCase);

export interface GameState {
    doubt: number;
    credibility: number;
    suspicion: number;
    revealedEvidenceIds: string[];
}
