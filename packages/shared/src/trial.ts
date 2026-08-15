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

import type { GameEffects, GameState, TrialNode, Verdict, VerdictRules } from "./case.js";

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
 * A conviction below the acquittal line still carries reasonable doubt once the
 * player is halfway to it. Derived rather than generated: a third
 * model-chosen threshold is a third thing the model can set nonsensically.
 */
const REASONABLE_DOUBT_FRACTION = 0.5;
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
    choiceIndex: number,
): TrialTurn | null {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
        return null;
    }
    // Covers negative, fractional and out-of-range indexes in one lookup.
    const choice = node.choices[choiceIndex];
    if (!choice) {
        return null;
    }
    return { state: applyEffects(state, choice.effects), nextNodeId: choice.nextNodeId };
}

function reasonableDoubtAt(rules: VerdictRules): number {
    return rules.acquitAtDoubt * REASONABLE_DOUBT_FRACTION;
}

export function resolveVerdict(state: GameState, rules: VerdictRules): Verdict {
    if (state.doubt >= rules.acquitAtDoubt) {
        return state.suspicion >= rules.suspiciousAtSuspicion
            ? "NOT_GUILTY_BUT_SUSPICIOUS"
            : "NOT_GUILTY";
    }
    // Suspicion only ever taints an acquittal. A convicted defendant being
    // suspicious on top is not a fifth verdict.
    return state.doubt >= reasonableDoubtAt(rules) ? "GUILTY_BUT_REASONABLE_DOUBT" : "GUILTY";
}

/**
 * Walks every run from the root and reports the extremes. Used twice: to
 * calibrate the defense score against what this particular tree makes possible,
 * and by the generator's validator to reject a tree whose verdict no run can
 * move.
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

/**
 * Whether the player's choices can actually move the verdict.
 *
 * This is deliberately not "the case must be winnable". gamedesign.md 8 lists
 * hidden truths where the dog did it, and 10 sanctions losing the case with a
 * high defense score, so a tree whose best run falls short of acquittal is a
 * legitimate hard case. What is not legitimate is a tree where every run lands
 * on the same verdict: then the choices are decoration and the trial is a
 * cutscene. That happens in both directions - a threshold above anything the
 * tree can reach, and one below everything it can reach.
 */
export function verdictCanVary(bounds: PathBounds, rules: VerdictRules): boolean {
    return [rules.acquitAtDoubt, reasonableDoubtAt(rules)].some(
        (threshold) => bounds.minDoubt < threshold && threshold <= bounds.maxDoubt,
    );
}

function ratio(value: number, best: number): number {
    if (best <= 0) {
        return 0;
    }
    return Math.min(Math.max(value / best, 0), 1);
}

/**
 * 0-100, measured against what this tree makes possible rather than an absolute
 * scale. A case the player cannot win still scores 100 for a run that took
 * every point on offer, which is what lets a loss read as an excellent defense
 * (gamedesign.md 10).
 */
export function scoreDefense(state: GameState, nodes: TrialNode[], rootNodeId: string): number {
    const bounds = pathBounds(nodes, rootNodeId);
    const raw =
        DOUBT_WEIGHT * ratio(state.doubt, bounds.maxDoubt) +
        CREDIBILITY_WEIGHT * ratio(state.credibility, bounds.maxCredibility);
    return Math.round(raw * 100);
}
