import { describe, expect, it } from "vitest";
import type { GameState, TrialNode } from "@paw-order/shared";
import {
    initialState,
    pathBounds,
    resolveVerdict,
    scoreDefense,
    takeChoice,
    verdictCanVary,
} from "@paw-order/shared";
import { fixtureTree } from "@/cases_bundle/services/case_fixture";

const RULES = { acquitAtDoubt: 60, suspiciousAtSuspicion: 50 };

/**
 * Plays a run from the root, one choice index per node visited. Returns the
 * state the verdict would be read from. Throws rather than returning null so a
 * mistyped path in a test fails loudly instead of scoring an empty run.
 */
function play(nodes: TrialNode[], rootNodeId: string, choiceIndexes: number[]): GameState {
    let state = initialState();
    let nodeId: string | null = rootNodeId;
    for (const choiceIndex of choiceIndexes) {
        if (nodeId === null) {
            throw new Error("the trial ended before the run did");
        }
        const turn = takeChoice(nodes, state, nodeId, choiceIndex);
        if (!turn) {
            throw new Error(`no choice ${String(choiceIndex)} at node ${nodeId}`);
        }
        state = turn.state;
        nodeId = turn.nextNodeId;
    }
    return state;
}

describe("initialState", () => {
    it("starts every stat at zero with nothing revealed", () => {
        expect(initialState()).toEqual({
            doubt: 0,
            credibility: 0,
            suspicion: 0,
            revealedEvidenceIds: [],
        });
    });
});

describe("takeChoice", () => {
    const { nodes } = fixtureTree();

    it("applies the deltas and follows the choice to the next node", () => {
        const turn = takeChoice(nodes, initialState(), "N1", 1);
        expect(turn).toBeDefined();
        expect(turn?.state).toEqual({
            doubt: 10,
            credibility: 5,
            suspicion: 0,
            revealedEvidenceIds: ["E3"],
        });
        expect(turn?.nextNodeId).toBe("N3");
    });

    it("reports the end of the trial as a null next node", () => {
        const turn = takeChoice(nodes, initialState(), "N3", 1);
        expect(turn?.nextNodeId).toBeNull();
    });

    it("leaves the state it was given untouched", () => {
        const before = initialState();
        takeChoice(nodes, before, "N1", 0);
        expect(before).toEqual(initialState());
    });

    it("reveals an exhibit once however often it is named", () => {
        const first = takeChoice(nodes, initialState(), "N1", 1);
        expect(first).toBeDefined();
        // E3 is revealed by N1's second choice; revealing it again must not
        // duplicate the id, or the verdict screen lists the exhibit twice.
        const again = takeChoice(nodes, first?.state ?? initialState(), "N1", 1);
        expect(again?.state.revealedEvidenceIds).toEqual(["E3"]);
    });

    it("refuses a node it does not know", () => {
        expect(takeChoice(nodes, initialState(), "N99", 0)).toBeNull();
    });

    it("refuses a choice index outside the node's choices", () => {
        expect(takeChoice(nodes, initialState(), "N1", 2)).toBeNull();
        expect(takeChoice(nodes, initialState(), "N1", -1)).toBeNull();
        expect(takeChoice(nodes, initialState(), "N1", 1.5)).toBeNull();
    });
});

describe("resolveVerdict", () => {
    function stateWith(doubt: number, suspicion: number): GameState {
        return { doubt, credibility: 0, suspicion, revealedEvidenceIds: [] };
    }

    it("acquits cleanly at the doubt threshold with suspicion below its own", () => {
        expect(resolveVerdict(stateWith(60, 49), RULES)).toBe("NOT_GUILTY");
    });

    it("taints the acquittal once suspicion reaches its threshold", () => {
        expect(resolveVerdict(stateWith(60, 50), RULES)).toBe("NOT_GUILTY_BUT_SUSPICIOUS");
    });

    it("convicts with reasonable doubt at half the acquittal threshold", () => {
        expect(resolveVerdict(stateWith(30, 0), RULES)).toBe("GUILTY_BUT_REASONABLE_DOUBT");
    });

    it("convicts outright below that", () => {
        expect(resolveVerdict(stateWith(29, 0), RULES)).toBe("GUILTY");
    });

    it("ignores suspicion on a conviction", () => {
        expect(resolveVerdict(stateWith(0, 99), RULES)).toBe("GUILTY");
    });
});

describe("pathBounds", () => {
    it("finds the best and worst the fixture tree can be played to", () => {
        const { nodes, rootNodeId } = fixtureTree();
        // Hand-walked: the doubt-maximal run is N1>N3>N5>N6 taking the first
        // choice each time and the second at N6. Credibility peaks on a
        // different run, which is why the two are tracked separately.
        expect(pathBounds(nodes, rootNodeId)).toEqual({
            minDoubt: 10,
            maxDoubt: 55,
            maxCredibility: 30,
        });
    });

    it("counts an ending choice's own effects", () => {
        const nodes: TrialNode[] = [
            {
                id: "A",
                speaker: "JUDGE",
                statement: "Anything further?",
                evidenceIds: [],
                choices: [
                    {
                        text: "No.",
                        effects: { doubt: 3, credibility: 7, suspicion: 0, revealsEvidenceIds: [] },
                        nextNodeId: null,
                    },
                ],
            },
        ];
        expect(pathBounds(nodes, "A")).toEqual({
            minDoubt: 3,
            maxDoubt: 3,
            maxCredibility: 7,
        });
    });

    it("returns a zero span for a root that is not in the tree", () => {
        expect(pathBounds(fixtureTree().nodes, "N99")).toEqual({
            minDoubt: 0,
            maxDoubt: 0,
            maxCredibility: 0,
        });
    });
});

describe("verdictCanVary", () => {
    const bounds = { minDoubt: 10, maxDoubt: 55, maxCredibility: 30 };

    it("accepts a case the player can lose but still swing", () => {
        // Acquittal is out of reach at 60, which gamedesign 8 sanctions, but
        // the run still crosses the reasonable-doubt line at 30.
        expect(verdictCanVary(bounds, RULES)).toBe(true);
    });

    it("rejects a case no run can move off GUILTY", () => {
        expect(verdictCanVary(bounds, { ...RULES, acquitAtDoubt: 250 })).toBe(false);
    });

    it("rejects a case every run acquits", () => {
        expect(verdictCanVary(bounds, { ...RULES, acquitAtDoubt: 5 })).toBe(false);
    });

    it("accepts a case where only the acquittal line is crossable", () => {
        // Every run already clears reasonable doubt, so that line proves
        // nothing; the acquittal line is the one the player is playing for.
        expect(verdictCanVary({ ...bounds, minDoubt: 40, maxDoubt: 70 }, RULES)).toBe(true);
    });
});

describe("scoreDefense", () => {
    const { nodes, rootNodeId } = fixtureTree();

    it("scores the doubt-maximal run on the fixture's own scale", () => {
        // Every point of doubt the tree offers, but 20 of 30 credibility: the
        // strongest possible case is not automatically the best-argued one.
        const state = play(nodes, rootNodeId, [1, 0, 0, 1]);
        expect(state.doubt).toBe(55);
        expect(state.credibility).toBe(20);
        expect(scoreDefense(state, nodes, rootNodeId)).toBe(95);
    });

    it("scores a run that concedes early well below a fought one", () => {
        // 10 of 55 doubt and 10 of 30 credibility: 0.85*(10/55) + 0.15*(10/30).
        const state = play(nodes, rootNodeId, [1, 1]);
        expect(state).toMatchObject({ doubt: 10, credibility: 10 });
        expect(scoreDefense(state, nodes, rootNodeId)).toBe(20);
    });

    it("never reports a negative score", () => {
        const state = { doubt: -40, credibility: -40, suspicion: 0, revealedEvidenceIds: [] };
        expect(scoreDefense(state, nodes, rootNodeId)).toBe(0);
    });

    it("scores zero rather than dividing by a tree with no doubt to win", () => {
        const flat: TrialNode[] = [
            {
                id: "A",
                speaker: "JUDGE",
                statement: "Anything further?",
                evidenceIds: [],
                choices: [
                    {
                        text: "No.",
                        effects: { doubt: 0, credibility: 0, suspicion: 0, revealsEvidenceIds: [] },
                        nextNodeId: null,
                    },
                ],
            },
        ];
        expect(scoreDefense(initialState(), flat, "A")).toBe(0);
    });
});
