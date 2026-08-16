/**
 * The trial engine: pure functions over a Case Bible, no io and no model call.
 * The AI creates the world, this runs the game (gamedesign.md 12).
 *
 * Nothing here reads `truth`. The verdict is a function of the player's state
 * and the generated rules alone, which is what keeps the hidden truth out of
 * the calculation and therefore out of anything derived from it.
 *
 * It lives in shared so the api can be the authority on it while the app can
 * still render a score from the same code.
 */

import type {
    Evidence,
    GameEffects,
    GameState,
    PublicEvidence,
    PublicTrialNode,
    PublicWitness,
    TrialNode,
    Verdict,
    VerdictRules,
    Witness,
} from "./case.js";

export interface TrialTurn {
    state: GameState;
    /** null means the trial is over and the verdict is next. */
    nextNodeId: string | null;
}

/** What the tree can be played to, over every run from the root. */
export interface PathBounds {
    minDoubt: number;
    maxDoubt: number;
    maxCredibility: number;
}

/**
 * Where the two doubt lines sit in the spread of runs the tree can actually be
 * played to: the top 30% of endings acquit, the bottom 30% convict outright,
 * the middle band convicts with reasonable doubt. Quantiles rather than fixed
 * numbers because every generated tree totals doubt on its own scale.
 */
const ACQUIT_QUANTILE = 0.7;
const REASONABLE_DOUBT_QUANTILE = 0.3;
/** Half the acquittals are tainted, when suspicion varies enough to split them. */
const SUSPICIOUS_QUANTILE = 0.5;
/**
 * Endings are enumerated, so a pathological tree is exponential. Real ones sit
 * around 40. Past this the tree is rejected rather than partially scored.
 */
const MAX_ENDINGS = 5000;
/**
 * Doubt is what wins the case, credibility is how well it was argued, so the
 * split is heavy on doubt but not total - a player who maxes doubt by conceding
 * every point of standing should not read 100.
 */
const DOUBT_WEIGHT = 0.85;
const CREDIBILITY_WEIGHT = 0.15;

const NO_BOUNDS: PathBounds = { minDoubt: 0, maxDoubt: 0, maxCredibility: 0 };

export function initialState(): GameState {
    return { doubt: 0, credibility: 0, suspicion: 0, revealedEvidenceIds: [] };
}

function applyEffects(state: GameState, effects: GameEffects): GameState {
    // A set, not a concat: a run can pass the same reveal twice and the verdict
    // screen would then list the exhibit twice.
    const revealed = new Set(state.revealedEvidenceIds);
    for (const id of effects.revealsEvidenceIds) {
        revealed.add(id);
    }
    return {
        doubt: state.doubt + effects.doubt,
        credibility: state.credibility + effects.credibility,
        suspicion: state.suspicion + effects.suspicion,
        revealedEvidenceIds: [...revealed],
    };
}

/**
 * Advances one turn. Returns null when the node or the choice does not exist:
 * both come from the client, so neither is trusted. Choices have no id of their
 * own, so the index into `choices` is the identifier a caller quotes back.
 *
 * `state` is not mutated; the caller keeps whichever one it decides to store.
 */
export function takeChoice(
    nodes: TrialNode[],
    state: GameState,
    nodeId: string,
    choiceIndex: unknown,
): TrialTurn | null {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
        return null;
    }
    // `unknown`, because the index arrives from a json body and a declared
    // `number` is not a runtime check. Indexing the array is not a bounds check
    // on its own either: choices["length"] is the array length, truthy enough
    // to pass the guard below, and applyEffects would then read .effects off a
    // number and throw where the contract promises null. The typeof narrows;
    // isInteger rejects NaN and fractions; the lookup covers negative and
    // out-of-range.
    if (typeof choiceIndex !== "number" || !Number.isInteger(choiceIndex)) {
        return null;
    }
    const choice = node.choices[choiceIndex];
    if (!choice) {
        return null;
    }
    return { state: applyEffects(state, choice.effects), nextNodeId: choice.nextNodeId };
}

/**
 * Strips a node down to what the courtroom may see. Every field is listed by
 * hand rather than spread-and-delete: a spread would carry any field added to
 * TrialNode later straight onto the wire, and the whole point of this function
 * is that adding one has to be a deliberate act.
 */
export function publicNode(node: TrialNode): PublicTrialNode {
    return {
        id: node.id,
        speaker: node.speaker,
        statement: node.statement,
        evidenceIds: node.evidenceIds,
        choices: node.choices.map((choice) => ({ text: choice.text })),
    };
}

/**
 * Strips an exhibit for the wire. Hand-written for the same reason publicNode
 * is: the rest-spread this replaces (`({ imagePrompt: _prompt, ...exhibit })`)
 * carries every field added to Evidence later, so a field naming who planted an
 * exhibit would ship with no compile error and no test failure.
 */
export function publicEvidence(exhibit: Evidence): PublicEvidence {
    return {
        id: exhibit.id,
        label: exhibit.label,
        imageUrl: exhibit.imageUrl,
        // Normalised, not copied: cases persisted before thumbUrl existed
        // deserialize without the key, and an undefined would be dropped by
        // JSON.stringify entirely - leaving the field absent from a response
        // whose type says it is always there.
        thumbUrl: exhibit.thumbUrl ?? null,
        visualFacts: exhibit.visualFacts,
    };
}

/** Same, for a witness: the claim, never `reliable`, never anything added later. */
export function publicWitness(witness: Witness): PublicWitness {
    return { id: witness.id, name: witness.name, claim: witness.claim };
}

/**
 * What `reasonableDoubtAtDoubt` replaced: the line used to be derived as half
 * the acquittal threshold rather than stored.
 */
const LEGACY_REASONABLE_DOUBT_FRACTION = 0.5;

/**
 * The reasonable-doubt line, tolerating a bible written before that line was
 * stored. The whole Case Bible is one json column that nothing migrates and
 * nothing re-validates on read, so its shape is a claim rather than a fact:
 * a pre-existing row carries only acquitAtDoubt and suspiciousAtSuspicion, and
 * a bare `state.doubt >= rules.reasonableDoubtAtDoubt` reads undefined, compares
 * false, and silently convicts outright where the case used to allow reasonable
 * doubt. Falling back to the old derivation keeps those cases playing as they
 * were generated.
 */
function reasonableDoubtLine(rules: VerdictRules): number {
    return Number.isFinite(rules.reasonableDoubtAtDoubt)
        ? rules.reasonableDoubtAtDoubt
        : rules.acquitAtDoubt * LEGACY_REASONABLE_DOUBT_FRACTION;
}

export function resolveVerdict(state: GameState, rules: VerdictRules): Verdict {
    if (state.doubt >= rules.acquitAtDoubt) {
        return state.suspicion >= rules.suspiciousAtSuspicion
            ? "NOT_GUILTY_BUT_SUSPICIOUS"
            : "NOT_GUILTY";
    }
    // Suspicion only ever taints an acquittal. A convicted defendant being
    // suspicious on top is not a fifth verdict.
    return state.doubt >= reasonableDoubtLine(rules) ? "GUILTY_BUT_REASONABLE_DOUBT" : "GUILTY";
}

/**
 * Every run the tree can be played to, as the state the verdict would read.
 * Null means the tree has more runs than MAX_ENDINGS, which is a rejection.
 *
 * Cycle-safe for the same reason pathBounds is: the validator calls this on
 * model output, and a node already on the current path is skipped rather than
 * recursed into. Unlike pathBounds there is no memo — the state carried in
 * differs per path, so a node's endings are not reusable between them.
 */
export function enumerateEndings(nodes: TrialNode[], rootNodeId: string): GameState[] | null {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const endings: GameState[] = [];
    const onPath = new Set<string>();
    let overflowed = false;

    const walk = (nodeId: string, state: GameState): void => {
        const node = byId.get(nodeId);
        if (!node || overflowed || onPath.has(nodeId)) {
            return;
        }
        onPath.add(nodeId);
        for (const choice of node.choices) {
            const next = applyEffects(state, choice.effects);
            if (choice.nextNodeId === null) {
                if (endings.length >= MAX_ENDINGS) {
                    overflowed = true;
                    break;
                }
                endings.push(next);
            } else {
                walk(choice.nextNodeId, next);
            }
        }
        onPath.delete(nodeId);
    };

    walk(rootNodeId, initialState());
    return overflowed ? null : endings;
}

/**
 * The value at `quantile` of an ascending list, counting only values strictly
 * above `floor`. Null when there are none.
 *
 * Every threshold here has to clear the lowest run in the tree, and a plain
 * quantile does not: on endings of 0, 0, 10, 20, 30, 40 the 30th percentile
 * lands on 0 itself, so every run sits at or above it and the verdict below
 * that line becomes unreachable. Ties at the minimum are not unusual - two
 * branches that concede early bottom out at the same total - so this is the
 * common case, not a pathological one.
 */
function splitAbove(sorted: number[], quantile: number, floor: number): number | null {
    const above = sorted.filter((value) => value > floor);
    const index = Math.min(above.length - 1, Math.floor(above.length * quantile));
    return above[index] ?? null;
}

/**
 * Places the verdict thresholds inside the spread of runs the tree actually
 * offers, so the same quantiles hold whatever scale the model wrote its effects
 * on. Null when the tree does not vary its doubt at all: then no choice decides
 * anything and the trial is a cutscene (gamedesign.md 7).
 */
export function deriveVerdictRules(endings: GameState[]): VerdictRules | null {
    if (endings.length === 0) {
        return null;
    }
    const doubts = endings.map((ending) => ending.doubt).sort((a, b) => a - b);
    const lowest = doubts[0];
    if (lowest === undefined) {
        return null;
    }
    const acquitAtDoubt = splitAbove(doubts, ACQUIT_QUANTILE, lowest);
    // Null means nothing sits above the lowest total, so every run in the tree
    // ends on the same doubt - the one case worth rejecting.
    if (acquitAtDoubt === null) {
        return null;
    }
    // Drawn from the runs BETWEEN the two extremes, not from the whole list.
    // Two independent quantiles over one list can land on the same value, which
    // empties the middle band and makes GUILTY_BUT_REASONABLE_DOUBT unreachable
    // while both lines still look placed. When no run falls between them the
    // tree has no middle band to offer, and the lines coincide honestly.
    const middle = doubts.filter((doubt) => doubt > lowest && doubt < acquitAtDoubt);
    const reasonableDoubtAtDoubt =
        splitAbove(middle, REASONABLE_DOUBT_QUANTILE, lowest) ?? acquitAtDoubt;

    // Only the runs that acquit matter here: the threshold's whole job is to
    // split those into clean and tainted.
    const suspicions = endings
        .filter((ending) => ending.doubt >= acquitAtDoubt)
        .map((ending) => ending.suspicion)
        .sort((a, b) => a - b);
    return {
        acquitAtDoubt,
        reasonableDoubtAtDoubt,
        suspiciousAtSuspicion: suspiciousAt(suspicions),
    };
}

/**
 * A threshold that leaves at least one acquittal clean. Taken from the values
 * above the lowest rather than from the list itself, because acquitting runs
 * routinely share one suspicion total — and a quantile over ties lands ON that
 * shared value, which would taint every acquittal in the case. When they all
 * tie there is nothing to split, so the threshold goes out of reach instead:
 * an untainted acquittal is the right default when the tree offers no signal.
 */
function suspiciousAt(sorted: number[]): number {
    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];
    if (lowest === undefined || highest === undefined) {
        return 1;
    }
    return splitAbove(sorted, SUSPICIOUS_QUANTILE, lowest) ?? highest + 1;
}

/**
 * Walks every run from the root and reports the extremes, which is what the
 * defense score is calibrated against — a run is measured by what this
 * particular tree made possible, not on an absolute scale.
 *
 * Cycle-safe on purpose. validateTree rejects cyclic trees, but it calls this
 * before that rejection is returned, and the nodes are model output - a naive
 * recursion would be a stack overflow triggerable by a bad generation. A node
 * already on the current path contributes nothing rather than recursing. The
 * memo can therefore hold a truncated figure for a cyclic tree, which is
 * harmless: such a tree is rejected regardless of what this returns.
 */
export function pathBounds(nodes: TrialNode[], rootNodeId: string): PathBounds {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const memo = new Map<string, PathBounds>();
    const onPath = new Set<string>();

    const walk = (nodeId: string): PathBounds => {
        const cached = memo.get(nodeId);
        if (cached) {
            return cached;
        }
        if (onPath.has(nodeId)) {
            return NO_BOUNDS;
        }
        const node = byId.get(nodeId);
        if (!node || node.choices.length === 0) {
            return NO_BOUNDS;
        }

        onPath.add(nodeId);
        let minDoubt = Number.POSITIVE_INFINITY;
        let maxDoubt = Number.NEGATIVE_INFINITY;
        let maxCredibility = Number.NEGATIVE_INFINITY;
        for (const choice of node.choices) {
            // An ending choice still scores its own effects; only what comes
            // after it is empty.
            const rest = choice.nextNodeId === null ? NO_BOUNDS : walk(choice.nextNodeId);
            minDoubt = Math.min(minDoubt, choice.effects.doubt + rest.minDoubt);
            maxDoubt = Math.max(maxDoubt, choice.effects.doubt + rest.maxDoubt);
            maxCredibility = Math.max(
                maxCredibility,
                choice.effects.credibility + rest.maxCredibility,
            );
        }
        onPath.delete(nodeId);

        const bounds: PathBounds = { minDoubt, maxDoubt, maxCredibility };
        memo.set(nodeId, bounds);
        return bounds;
    };

    return byId.has(rootNodeId) ? walk(rootNodeId) : NO_BOUNDS;
}

function ratio(value: number, best: number): number {
    if (best <= 0) {
        return 0;
    }
    return Math.min(Math.max(value / best, 0), 1);
}

/**
 * 0-100, measured against what this tree makes possible rather than an absolute
 * scale, which is what lets a loss read as an excellent defense
 * (gamedesign.md 10).
 *
 * The ceiling is tree-dependent and usually below 100: doubt and credibility
 * are normalised against their own best runs, and those are rarely the same
 * run. On the fixture the doubt-maximal run scores 95 and the
 * credibility-maximal one 92. Winning the case and arguing it best are
 * deliberately separate achievements.
 */
export function scoreDefense(state: GameState, nodes: TrialNode[], rootNodeId: string): number {
    const bounds = pathBounds(nodes, rootNodeId);
    const raw =
        DOUBT_WEIGHT * ratio(state.doubt, bounds.maxDoubt) +
        CREDIBILITY_WEIGHT * ratio(state.credibility, bounds.maxCredibility);
    return Math.round(raw * 100);
}
