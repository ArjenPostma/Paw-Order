import type { CaseBible, PublicEvidence, TurnResponse } from "@paw-order/shared";
import {
    initialState,
    publicNode,
    resolveVerdict,
    scoreDefense,
    takeChoice,
} from "@paw-order/shared";
import { AppDataSource } from "@/database_bundle/util/data_source";
import { CaseEntity } from "@/cases_bundle/models/case_entity";

/**
 * Running the trial. The api is the authority: it holds the effects table, the
 * tree edges and the thresholds, and the client only ever names a choice by its
 * index.
 *
 * Nothing about a run is stored. The client posts the indexes taken so far and
 * the whole run is replayed from the root each turn, so the state is always
 * computed and never accepted - there is no session to steal, no row to reap,
 * and a tampered request is simply a different (still legal) run. The tree is
 * at most 24 nodes, so replaying it is cheaper than the database read that
 * precedes it.
 */

/** Not a TurnResponse: the caller maps these onto status codes. */
export type TurnOutcome = TurnResponse | "NOT_PLAYABLE" | "INVALID_PATH";

function repository() {
    return AppDataSource.getRepository(CaseEntity);
}

export async function playTurn(id: string, path: unknown): Promise<TurnOutcome> {
    const entity = await repository().findOne({ where: { id } });
    // A PENDING row holds the placeholder bible and a FAILED one holds whatever
    // it had when it died. Neither is playable, and neither is distinguishable
    // from a missing case as far as the caller is concerned.
    if (!entity || entity.status !== "READY") {
        return "NOT_PLAYABLE";
    }
    return replayRun(entity.bible, path);
}

/**
 * The exhibits a run has unlocked: what the nodes it visited put in play, plus
 * what its choices revealed. Both halves matter - a statement that cites an
 * exhibit has to be readable alongside it, and a choice that reveals one has to
 * actually hand it over.
 */
function unlockedEvidence(bible: CaseBible, ids: Set<string>): PublicEvidence[] {
    return bible.evidence
        .filter((exhibit) => ids.has(exhibit.id))
        .map(({ imagePrompt: _prompt, ...exhibit }) => exhibit);
}

function replayRun(bible: CaseBible, path: unknown): TurnOutcome {
    if (!Array.isArray(bible.nodes)) {
        // Only reachable for a row written around validateTree, but this is a
        // json column: treat its shape as a claim, not a fact.
        console.error("[paw-order-api] bible has no node array");
        return "NOT_PLAYABLE";
    }
    if (!Array.isArray(path)) {
        return "INVALID_PATH";
    }
    // No run can visit more nodes than the tree has: the validator rejects
    // cycles, so every path is simple. Without this a caller could post a
    // million-entry array and make the api walk it.
    const steps: unknown[] = path;
    if (steps.length > bible.nodes.length) {
        return "INVALID_PATH";
    }

    const nodeById = new Map(bible.nodes.map((node) => [node.id, node]));
    const root = nodeById.get(bible.rootNodeId);
    if (!root) {
        // Matches findCaseStatus: a READY case with no opening statement is a
        // broken case, not a bad request, and the operator needs to hear it.
        console.error("[paw-order-api] bible is READY with no root node");
        return "NOT_PLAYABLE";
    }

    let state = initialState();
    let nodeId: string | null = bible.rootNodeId;
    const seen = new Set(root.evidenceIds);
    for (const choiceIndex of steps) {
        // A step after the trial ended is not a legal run, even though every
        // step before it was.
        if (nodeId === null) {
            return "INVALID_PATH";
        }
        const turn = takeChoice(bible.nodes, state, nodeId, choiceIndex);
        if (!turn) {
            return "INVALID_PATH";
        }
        state = turn.state;
        nodeId = turn.nextNodeId;
        for (const id of nodeById.get(nodeId ?? "")?.evidenceIds ?? []) {
            seen.add(id);
        }
    }
    for (const id of state.revealedEvidenceIds) {
        seen.add(id);
    }

    if (nodeId === null) {
        return {
            status: "VERDICT",
            verdict: resolveVerdict(state, bible.verdictRules),
            score: scoreDefense(state, bible.nodes, bible.rootNodeId),
            truth: bible.truth,
            // Everything, once the trial is over: the verdict screen is where
            // the case is explained, so withholding exhibits there serves
            // nothing.
            evidence: unlockedEvidence(bible, new Set(bible.evidence.map((item) => item.id))),
        };
    }

    const node = nodeById.get(nodeId);
    if (!node) {
        // validateTree rejects a choice pointing at an unknown node, which is
        // what makes this unreachable - takeChoice returns nextNodeId verbatim
        // and never resolves it itself. Narrowing beats a non-null assertion.
        return "INVALID_PATH";
    }
    return {
        status: "NODE",
        node: publicNode(node),
        evidence: unlockedEvidence(bible, seen),
    };
}
