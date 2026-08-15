import type { CaseBible } from "@paw-order/shared";
import type { GeneratedFacts, GeneratedTree } from "@/cases_bundle/services/case_validator";

/**
 * A hand-written case that satisfies both validators. The generator returns it
 * verbatim when APP_ENV=test, the same way r2.ts refuses to touch a real bucket
 * there: the suite must never make a model call. It is also the fixture the
 * validator tests mutate, and the one the trial engine will run against.
 */

export function fixtureFacts(): GeneratedFacts {
    return {
        defendantName: "Rumbles",
        crime: {
            charge: "Grand Theft Birthday Cake",
            title: "The Great Birthday Cake Heist",
            location: "The family kitchen",
            timeline: [
                "14:00 - Cake placed on the counter",
                "14:12 - Owner leaves the kitchen",
                "14:18 - Cake discovered destroyed",
                "14:25 - Defendant discovered nearby",
            ],
        },
        truth: {
            summary: "The cake slid off the counter on its own. The defendant only cleaned up.",
            misleadingEvidenceIds: ["E2"],
        },
        evidence: [
            {
                id: "E1",
                label: "The defendant beside the ruined cake",
                imagePrompt:
                    "The dog from the reference photo sitting beside a collapsed cake, with two sets of pawprints of different sizes crossing the tiles.",
                imageUrl: null,
                // Two facts on one exhibit: the scene and the pawprints that
                // contradict the "only one animal" line. Kept together because
                // EVIDENCE_COUNT is 3 and both are visible in the same shot.
                visualFacts: [
                    "a collapsed chocolate cake on the kitchen floor",
                    "two sets of pawprints of different sizes",
                ],
            },
            {
                id: "E2",
                label: "Frosting on the muzzle",
                imagePrompt: "Close photograph of the dog from the reference photo, muzzle first.",
                imageUrl: null,
                visualFacts: ["white frosting around the dog's mouth"],
            },
            {
                id: "E3",
                label: "The kitchen clock",
                imagePrompt: "A wall clock in a kitchen, hands clearly readable.",
                imageUrl: null,
                visualFacts: ["a wall clock reading 14:22"],
            },
        ],
        witnesses: [
            {
                id: "W1",
                name: "Mrs Pemberton",
                claim: "The defendant entered the kitchen at 14:30 and never left.",
                reliable: false,
            },
            {
                id: "W2",
                name: "Officer Dolan",
                claim: "The cake was already on the floor when I arrived.",
                reliable: true,
            },
        ],
    };
}

export function fixtureTree(): GeneratedTree {
    return {
        rootNodeId: "N1",
        verdictRules: { acquitAtDoubt: 60, suspiciousAtSuspicion: 50 },
        nodes: [
            {
                id: "N1",
                speaker: "PROSECUTOR",
                statement: "Your client was found beside a collapsed cake. Explain that.",
                evidenceIds: ["E1"],
                choices: [
                    {
                        text: "Being near the cake proves nothing.",
                        effects: { doubt: 5, credibility: 0, suspicion: 0, revealsEvidenceIds: [] },
                        nextNodeId: "N2",
                    },
                    {
                        text: "When was this photograph taken?",
                        effects: {
                            doubt: 10,
                            credibility: 5,
                            suspicion: 0,
                            revealsEvidenceIds: ["E3"],
                        },
                        nextNodeId: "N3",
                    },
                ],
            },
            {
                id: "N2",
                speaker: "PROSECUTOR",
                statement: "Then explain the two sets of pawprints of different sizes.",
                evidenceIds: ["E1"],
                choices: [
                    {
                        text: "Two sets. So my client was not alone.",
                        effects: {
                            doubt: 15,
                            credibility: 5,
                            suspicion: -5,
                            revealsEvidenceIds: ["E1"],
                        },
                        nextNodeId: "N4",
                    },
                    {
                        text: "That does not establish that he ate anything.",
                        effects: {
                            doubt: 5,
                            credibility: -5,
                            suspicion: 5,
                            revealsEvidenceIds: [],
                        },
                        nextNodeId: null,
                    },
                ],
            },
            {
                id: "N3",
                speaker: "PROSECUTOR",
                statement: "The clock in the photograph reads 14:22.",
                evidenceIds: ["E3"],
                choices: [
                    {
                        text: "Then why does your witness say 14:30?",
                        effects: {
                            doubt: 20,
                            credibility: 10,
                            suspicion: 0,
                            revealsEvidenceIds: [],
                        },
                        nextNodeId: "N5",
                    },
                    {
                        text: "Thank you. No further questions.",
                        effects: { doubt: 0, credibility: 5, suspicion: 5, revealsEvidenceIds: [] },
                        nextNodeId: null,
                    },
                ],
            },
            {
                id: "N4",
                speaker: "WITNESS",
                statement: "I saw only the one dog. I am quite certain.",
                evidenceIds: ["E1"],
                choices: [
                    {
                        text: "You could not see the whole kitchen from the hallway.",
                        effects: {
                            doubt: 15,
                            credibility: -5,
                            suspicion: 0,
                            revealsEvidenceIds: [],
                        },
                        nextNodeId: "N6",
                    },
                    {
                        text: "No further questions.",
                        effects: { doubt: 0, credibility: 0, suspicion: 5, revealsEvidenceIds: [] },
                        nextNodeId: null,
                    },
                ],
            },
            {
                id: "N5",
                speaker: "JUDGE",
                statement: "Counsel, are you asking me to doubt the witness or the clock?",
                evidenceIds: ["E3"],
                choices: [
                    {
                        text: "The clock cannot be mistaken, Your Honour.",
                        effects: {
                            doubt: 15,
                            credibility: 10,
                            suspicion: 0,
                            revealsEvidenceIds: [],
                        },
                        nextNodeId: "N6",
                    },
                    {
                        text: "I withdraw the question.",
                        effects: {
                            doubt: -5,
                            credibility: -10,
                            suspicion: 5,
                            revealsEvidenceIds: [],
                        },
                        nextNodeId: null,
                    },
                ],
            },
            {
                id: "N6",
                speaker: "JUDGE",
                statement: "Anything further before I rule?",
                evidenceIds: [],
                choices: [
                    {
                        text: "The defense rests, Your Honour.",
                        effects: { doubt: 5, credibility: 5, suspicion: 0, revealsEvidenceIds: [] },
                        nextNodeId: null,
                    },
                    {
                        text: "One final point: the frosting was never tested.",
                        effects: {
                            doubt: 10,
                            credibility: -5,
                            suspicion: 0,
                            revealsEvidenceIds: ["E2"],
                        },
                        nextNodeId: null,
                    },
                ],
            },
        ],
    };
}

export function fixtureBible(photoUrl: string): CaseBible {
    const facts = fixtureFacts();
    const tree = fixtureTree();
    return {
        defendant: { name: facts.defendantName, photoUrl },
        crime: facts.crime,
        truth: facts.truth,
        evidence: facts.evidence,
        witnesses: facts.witnesses,
        nodes: tree.nodes,
        rootNodeId: tree.rootNodeId,
        verdictRules: tree.verdictRules,
    };
}
