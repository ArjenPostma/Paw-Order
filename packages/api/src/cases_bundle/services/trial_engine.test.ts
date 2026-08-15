import { describe, expect, it } from "vitest";
import type { GameState, TrialNode } from "@paw-order/shared";
import {
    deriveVerdictRules,
    enumerateEndings,
    initialState,
    pathBounds,
    resolveVerdict,
    scoreDefense,
    takeChoice,
} from "@paw-order/shared";
import { fixtureTree } from "@/cases_bundle/services/case_fixture";

const RULES = { acquitAtDoubt: 60, reasonableDoubtAtDoubt: 30, suspiciousAtSuspicion: 50 };

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
        expect(takeChoice(nodes, initialState(), "N1", Number.NaN)).toBeNull();
    });

    it("refuses a choice index that is not a number at all", () => {
        // The index arrives from a json body, so it can be any type. Indexing
        // the array is not on its own a bounds check: choices["length"] is the
        // array length, which is truthy, and the turn would then read .effects
        // off a number and throw rather than returning null.
        expect(takeChoice(nodes, initialState(), "N1", "length")).toBeNull();
        expect(takeChoice(nodes, initialState(), "N1", "0")).toBeNull();
        expect(takeChoice(nodes, initialState(), "N1", "constructor")).toBeNull();
        expect(takeChoice(nodes, initialState(), "N1", null)).toBeNull();
        expect(takeChoice(nodes, initialState(), "N1", { valueOf: () => 0 })).toBeNull();
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

    it("convicts with reasonable doubt at the reasonable-doubt threshold", () => {
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

/** One node whose single choice ends the trial with the given effects. */
function ending(id: string, doubt: number, suspicion: number): TrialNode {
    return {
        id,
        speaker: "JUDGE",
        statement: "Anything further?",
        evidenceIds: [],
        choices: [
            {
                text: "No.",
                effects: { doubt, credibility: 0, suspicion, revealsEvidenceIds: [] },
                nextNodeId: null,
            },
        ],
    };
}

describe("enumerateEndings", () => {
    it("returns the state every run of the fixture arrives at", () => {
        const { nodes, rootNodeId } = fixtureTree();
        const endings = enumerateEndings(nodes, rootNodeId);
        expect(endings).toBeDefined();
        // Hand-walked: eight runs, two of which concede at the first question.
        expect(endings?.map((state) => state.doubt).sort((a, b) => a - b)).toEqual([
            10, 10, 20, 25, 40, 45, 50, 55,
        ]);
    });

    it("stops at a node already on the run rather than looping forever", () => {
        const loop: TrialNode[] = [
            {
                id: "A",
                speaker: "JUDGE",
                statement: "Again?",
                evidenceIds: [],
                choices: [
                    {
                        text: "Again.",
                        effects: { doubt: 5, credibility: 0, suspicion: 0, revealsEvidenceIds: [] },
                        nextNodeId: "A",
                    },
                ],
            },
        ];
        expect(enumerateEndings(loop, "A")).toEqual([]);
    });

    it("returns no runs for a root that is not in the tree", () => {
        expect(enumerateEndings(fixtureTree().nodes, "N99")).toEqual([]);
    });
});

describe("deriveVerdictRules", () => {
    it("places both doubt lines inside the fixture's own spread", () => {
        // Doubts run 10..55 over eight endings, two of them tied at the 10 the
        // early concessions bottom out at. Both lines are placed among the runs
        // ABOVE that tie - 50 and 25 - so neither collapses onto the minimum
        // and leaves the verdict below it unreachable.
        expect(fixtureTree().verdictRules).toEqual({
            acquitAtDoubt: 50,
            reasonableDoubtAtDoubt: 25,
            suspiciousAtSuspicion: 5,
        });
    });

    it("makes all four verdicts reachable on the fixture", () => {
        const { nodes, rootNodeId, verdictRules } = fixtureTree();
        const endings = enumerateEndings(nodes, rootNodeId) ?? [];
        const reached = new Set(endings.map((state) => resolveVerdict(state, verdictRules)));
        expect([...reached].sort()).toEqual([
            "GUILTY",
            "GUILTY_BUT_REASONABLE_DOUBT",
            "NOT_GUILTY",
            "NOT_GUILTY_BUT_SUSPICIOUS",
        ]);
    });

    it("keeps a conviction reachable when runs tie at the lowest doubt", () => {
        // Two runs bottom out at 0, which is what an early concession looks
        // like. A plain 30th percentile over these six lands ON that 0, every
        // run then clears the reasonable-doubt line, and GUILTY quietly stops
        // existing. Both lines have to sit above the tie.
        const endings = [0, 0, 10, 20, 30, 40].map((doubt) => ({
            doubt,
            credibility: 0,
            suspicion: 0,
            revealedEvidenceIds: [],
        }));
        const rules = deriveVerdictRules(endings);
        expect(rules).toBeDefined();

        const reached = new Set(endings.map((state) => resolveVerdict(state, rules!)));
        expect(reached.has("GUILTY")).toBe(true);
    });

    it("refuses a tree whose runs all total the same doubt", () => {
        const flat = enumerateEndings([ending("A", 5, 0)], "A") ?? [];
        expect(deriveVerdictRules(flat)).toBeNull();
    });

    it("refuses a tree with no runs at all", () => {
        expect(deriveVerdictRules([])).toBeNull();
    });

    it("leaves every acquittal clean when suspicion cannot split them", () => {
        // All three acquitting runs share one suspicion total, so there is no
        // value that taints some and not others. The threshold goes out of
        // reach rather than tainting the lot.
        const endings = [
            { doubt: 0, credibility: 0, suspicion: 7, revealedEvidenceIds: [] },
            { doubt: 20, credibility: 0, suspicion: 7, revealedEvidenceIds: [] },
            { doubt: 20, credibility: 0, suspicion: 7, revealedEvidenceIds: [] },
            { doubt: 20, credibility: 0, suspicion: 7, revealedEvidenceIds: [] },
        ];
        const rules = deriveVerdictRules(endings);
        expect(rules).toBeDefined();
        expect(rules?.suspiciousAtSuspicion).toBe(8);
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
