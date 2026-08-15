import { describe, expect, it } from "vitest";
import { fixtureFacts, fixtureTree } from "@/cases_bundle/services/case_fixture";
import { validateFacts, validateTree } from "@/cases_bundle/services/case_validator";

/**
 * The validator is the only thing standing between a model response and a
 * courtroom, so each rejection it exists for gets an anchor here. The fixture is
 * cloned and broken one way at a time.
 */

function brokenFacts(mutate: (facts: ReturnType<typeof fixtureFacts>) => void): unknown {
    const facts = fixtureFacts();
    mutate(facts);
    return facts;
}

function brokenTree(mutate: (tree: ReturnType<typeof fixtureTree>) => void): unknown {
    const tree = fixtureTree();
    mutate(tree);
    return tree;
}

function errorsOf(result: { ok: boolean; errors?: string[] }): string {
    return (result.errors ?? []).join(" | ");
}

describe("validateFacts", () => {
    it("accepts the fixture", () => {
        expect(validateFacts(fixtureFacts()).ok).toBe(true);
    });

    it("rejects anything that is not an object", () => {
        expect(validateFacts(null).ok).toBe(false);
        expect(validateFacts("[]").ok).toBe(false);
    });

    it("rejects an exhibit with no visual facts", () => {
        const result = validateFacts(
            brokenFacts((facts) => {
                const exhibit = facts.evidence[0];
                expect(exhibit).toBeDefined();
                exhibit!.visualFacts = [];
            }),
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("visualFacts");
    });

    it("rejects the wrong number of exhibits", () => {
        const result = validateFacts(
            brokenFacts((facts) => {
                facts.evidence = facts.evidence.slice(0, 2);
            }),
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("exactly 3");
    });

    it("rejects a hidden truth that cites an exhibit that does not exist", () => {
        const result = validateFacts(
            brokenFacts((facts) => {
                facts.truth.misleadingEvidenceIds = ["E9"];
            }),
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("E9");
    });
});

describe("validateTree", () => {
    const evidence = fixtureFacts().evidence;

    it("accepts the fixture", () => {
        const result = validateTree(fixtureTree(), evidence);
        expect(errorsOf(result)).toBe("");
        expect(result.ok).toBe(true);
    });

    // The bounds moved out of TREE_SCHEMA because the endpoint rejects the whole
    // request when a nested array carries minItems/maxItems, so these two are now
    // the only thing keeping a runaway response out of the json column.
    it("rejects too few nodes", () => {
        const tree = fixtureTree();
        const result = validateTree({ ...tree, nodes: tree.nodes.slice(0, 2) }, evidence);
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("between 4 and 24 nodes");
    });

    it("rejects a runaway number of nodes", () => {
        const tree = fixtureTree();
        const first = tree.nodes[0];
        expect(first).toBeDefined();
        const padded = Array.from({ length: 40 }, (_, index) => ({
            ...first!,
            id: `P${String(index)}`,
        }));
        const result = validateTree({ ...tree, nodes: [...tree.nodes, ...padded] }, evidence);
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("between 4 and 24 nodes");
    });

    it("rejects a node with a single choice", () => {
        const result = validateTree(
            brokenTree((tree) => {
                const node = tree.nodes[0];
                expect(node).toBeDefined();
                node!.choices = node!.choices.slice(0, 1);
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("between 2 and 4 options");
    });

    it("rejects a choice pointing at a node that does not exist", () => {
        const result = validateTree(
            brokenTree((tree) => {
                const choice = tree.nodes[0]?.choices[0];
                expect(choice).toBeDefined();
                choice!.nextNodeId = "N99";
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("N99");
    });

    it("rejects a root that is not a node", () => {
        const result = validateTree(
            brokenTree((tree) => {
                tree.rootNodeId = "N42";
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("N42");
    });

    it("rejects an unreachable node", () => {
        const result = validateTree(
            brokenTree((tree) => {
                // Nothing points at N6 any more, so it is invented dead weight.
                for (const node of tree.nodes) {
                    for (const choice of node.choices) {
                        if (choice.nextNodeId === "N6") {
                            choice.nextNodeId = null;
                        }
                    }
                }
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("unreachable");
    });

    it("rejects a cycle", () => {
        const result = validateTree(
            brokenTree((tree) => {
                const last = tree.nodes[tree.nodes.length - 1];
                expect(last).toBeDefined();
                const choice = last!.choices[0];
                expect(choice).toBeDefined();
                choice!.nextNodeId = tree.rootNodeId;
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("cycle");
    });

    it("rejects a trial with no ending", () => {
        const result = validateTree(
            brokenTree((tree) => {
                for (const node of tree.nodes) {
                    for (const choice of node.choices) {
                        choice.nextNodeId = tree.rootNodeId;
                    }
                }
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("never ends");
    });

    it("rejects a statement citing an exhibit that does not exist", () => {
        const result = validateTree(
            brokenTree((tree) => {
                const node = tree.nodes[0];
                expect(node).toBeDefined();
                node!.evidenceIds = ["E7"];
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("E7");
    });

    it("rejects a reveal citing an exhibit that does not exist", () => {
        const result = validateTree(
            brokenTree((tree) => {
                const choice = tree.nodes[0]?.choices[0];
                expect(choice).toBeDefined();
                choice!.effects.revealsEvidenceIds = ["E8"];
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("E8");
    });

    it("rejects an unknown speaker", () => {
        // Built by spread rather than assignment: validateTree takes unknown, so
        // an invalid speaker needs no cast to express.
        const tree = fixtureTree();
        const nodes = tree.nodes.map((node, index) =>
            index === 0 ? { ...node, speaker: "BAILIFF" } : node,
        );

        const result = validateTree({ ...tree, nodes }, evidence);
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("speaker");
    });

    it("derives the thresholds from the tree rather than reading them", () => {
        // The model is not asked for verdictRules and cannot supply them: one
        // sent anyway is ignored, and the returned thresholds are the ones
        // deriveVerdictRules computes from the fixture's own endings.
        const result = validateTree(
            { ...fixtureTree(), verdictRules: { acquitAtDoubt: 999 } },
            evidence,
        );
        expect(result.ok).toBe(true);
        expect(result.ok && result.value.verdictRules).toEqual({
            acquitAtDoubt: 50,
            reasonableDoubtAtDoubt: 25,
            suspiciousAtSuspicion: 5,
        });
    });

    it("rejects a tree where every run totals the same doubt", () => {
        // Structurally fine, but no choice moves the verdict, so the trial is a
        // cutscene (gamedesign.md 7).
        const result = validateTree(
            brokenTree((tree) => {
                for (const node of tree.nodes) {
                    for (const choice of node.choices) {
                        choice.effects.doubt = 0;
                    }
                }
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("decides the verdict");
    });

    it("does not blame the thresholds for a graph that is already broken", () => {
        // Both of the root's choices dangle, so the only runs left total 5 and
        // 10 doubt and the derivation would fire on top of the real errors. The
        // whole error list is fed back as retry instructions, so a phantom
        // "fix your thresholds" line spends the one remaining attempt on a
        // repair that was never needed.
        const result = validateTree(
            brokenTree((tree) => {
                const root = tree.nodes[0];
                expect(root).toBeDefined();
                for (const choice of root?.choices ?? []) {
                    choice.nextNodeId = "N42";
                }
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("unknown node");
        expect(errorsOf(result)).not.toContain("decides the verdict");
    });

    it("does not walk a cyclic tree forever while collecting its errors", () => {
        const result = validateTree(
            brokenTree((tree) => {
                const choice = tree.nodes[5]?.choices[0];
                expect(choice).toBeDefined();
                if (choice) {
                    choice.nextNodeId = "N1";
                }
            }),
            evidence,
        );
        expect(result.ok).toBe(false);
        expect(errorsOf(result)).toContain("cycle");
    });

    it("clamps an effect magnitude instead of rejecting the tree", () => {
        const result = validateTree(
            brokenTree((tree) => {
                const choice = tree.nodes[0]?.choices[0];
                expect(choice).toBeDefined();
                choice!.effects.doubt = 9999;
            }),
            evidence,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.nodes[0]?.choices[0]?.effects.doubt).toBe(25);
        }
    });
});
