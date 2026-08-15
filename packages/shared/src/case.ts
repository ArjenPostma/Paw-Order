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

/**
 * Derived from the finished tree, never generated: see deriveVerdictRules. A
 * model asked for these picks them before it knows what its own effects total,
 * which put ~80% of runs on NOT_GUILTY and left NOT_GUILTY_BUT_SUSPICIOUS
 * unreachable across every case sampled.
 *
 * The doubt lines are guaranteed to divide the tree; the suspicion one is not.
 * When every acquitting run carries the same suspicion there is no value that
 * taints some and spares others, and the threshold goes out of reach rather
 * than tainting them all - so NOT_GUILTY_BUT_SUSPICIOUS can still be a dead
 * verdict on an individual case. That is left to the tree prompt, which asks
 * for suspicion to vary, rather than rejected here: a whole regeneration is too
 * much to spend on which flavour of acquittal a case can reach.
 */
export interface VerdictRules {
    /** Doubt at or above this acquits. */
    acquitAtDoubt: number;
    /** Doubt at or above this convicts with reasonable doubt rather than outright. */
    reasonableDoubtAtDoubt: number;
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
 * A choice as the courtroom sees one: the words, nothing else.
 *
 * `effects` is the doubt/credibility/suspicion table. On the wire it is a
 * solution key - sort by `effects.doubt` and the optimal path falls out without
 * reading a line of the trial, which is exactly the "no obviously correct
 * answer" rule in gamedesign.md section 7. `nextNodeId` is the map that makes
 * walking it possible. Both stay server-side; the player identifies a choice by
 * its index, and the api replays the run.
 */
export type PublicChoice = Omit<Choice, "effects" | "nextNodeId">;

export type PublicTrialNode = Omit<TrialNode, "choices"> & { choices: PublicChoice[] };

/**
 * What the client is allowed to see while the trial is running.
 *
 * `truth?: never` is load-bearing: a plain Omit is structurally satisfied by a
 * value that still carries truth (an object spread suppresses excess-property
 * checking), so `return { id, ...bible }` would typecheck and ship the answer.
 * With never, Truth is not assignable and that regression is a compile error.
 *
 * The trial arrives one node at a time, so `nodes` and `rootNodeId` are gone in
 * favour of `rootNode`. `verdictRules` goes with them: the verdict is computed
 * here now, and the thresholds are just a number to farm towards.
 */
/**
 * Pick, not Omit. An Omit ships every field of CaseBible that is not named,
 * so adding one to the bible later puts it on the wire with no compile error
 * and no test failure - the same hazard publicNode is hand-written to avoid,
 * one level up. With Pick, a new bible field reaches the client only when
 * someone adds it here on purpose. Build the response field by field too: an
 * object spread would carry it anyway.
 */
export type PublicCase = Pick<CaseBible, "defendant" | "crime"> & {
    id: string;
    truth?: never;
    /** Narrowed, not inherited: see PublicWitness and PublicEvidence. */
    witnesses: PublicWitness[];
    /**
     * Only the exhibits the opening node puts in play. The rest arrive as the
     * trial reveals them: shipping all three up front made revealsEvidenceIds
     * decorative, and let a player read E3's clock against W1's claim to work
     * out which witness is lying before the first question (gamedesign.md 8).
     */
    evidence: PublicEvidence[];
    rootNode: PublicTrialNode;
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

/**
 * A turn: the choice indexes taken so far, from the root. The run is replayed
 * server-side on every request, which is what makes it unforgeable - no state
 * crosses the wire, so there is none to tamper with. Bounded by the node count,
 * and the tree is small (gamedesign.md section 6).
 */
export interface TurnRequest {
    path: number[];
}

/**
 * `truth?: never` on the NODE arm for the same reason PublicCase carries it:
 * without it a future `return { status: "NODE", ...bible }` typechecks and
 * ships the answer mid-trial. The VERDICT arm is the first moment the truth is
 * allowed out (gamedesign.md sections 8 and 9).
 */
export type TurnResponse =
    | {
          status: "NODE";
          node: PublicTrialNode;
          /**
           * Every exhibit unlocked so far: the ones the nodes visited put in
           * play, plus the ones choices revealed. Sent whole rather than as
           * ids, because the client is no longer given the full exhibit list
           * to look them up in.
           */
          evidence: PublicEvidence[];
          truth?: never;
      }
    | {
          status: "VERDICT";
          verdict: Verdict;
          score: number;
          truth: Truth;
          evidence: PublicEvidence[];
      };

export interface GameState {
    doubt: number;
    credibility: number;
    suspicion: number;
    revealedEvidenceIds: string[];
}
