import type { CaseBible, TurnResponse } from "@paw-order/shared";
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
 * Exported for the unit tests: this is the whole game loop, and driving it
 * through HTTP for every branch would be slower without checking anything more.
 */
export function replayRun(bible: CaseBible, path: unknown): TurnOutcome {
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

    let state = initialState();
    let nodeId: string | null = bible.rootNodeId;
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
    }

    if (nodeId === null) {
        return {
            status: "VERDICT",
            verdict: resolveVerdict(state, bible.verdictRules),
            score: scoreDefense(state, bible.nodes, bible.rootNodeId),
            truth: bible.truth,
            revealedEvidenceIds: state.revealedEvidenceIds,
        };
    }

    const node = bible.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
        // takeChoice only ever returns an id it resolved, and rootNodeId is
        // validated before the case is stored, so this is unreachable for a
        // stored bible. It is not an assertion: narrowing beats a non-null.
        return "INVALID_PATH";
    }
    return {
        status: "NODE",
        node: publicNode(node),
        revealedEvidenceIds: state.revealedEvidenceIds,
    };
}
