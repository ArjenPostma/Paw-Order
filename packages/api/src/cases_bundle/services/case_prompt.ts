import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import type { GeneratedFacts } from "@/cases_bundle/services/case_validator";
import { EVIDENCE_COUNT, WITNESS_COUNT } from "@/cases_bundle/services/case_validator";

/**
 * Generation is two text calls, not one (gamedesign.md §12): facts first, then
 * the trial tree built from the *finalized* facts. That ordering is what makes
 * "the trial may only cite real visual facts" enforceable — the tree model is
 * handed the evidence ids and visualFacts as its whole world, and the validator
 * rejects any reference outside it. One combined call would let the model invent
 * an exhibit and a question about it in the same breath.
 *
 * ponytail: the response schemas below duplicate the shapes case_validator.ts
 * narrows to. Constrained decoding is worth the duplication (a structurally
 * invalid answer costs a whole retry), but the two must be edited together.
 */

/** Kept out of both prompts' way: the model never sets these. */
const NUMBER = { type: Type.NUMBER } as const;
const STRING = { type: Type.STRING } as const;
const STRING_LIST: Schema = { type: Type.ARRAY, items: { type: Type.STRING } };

export const FACTS_SCHEMA: Schema = {
    type: Type.OBJECT,
    required: ["defendantName", "crime", "truth", "evidence", "witnesses"],
    properties: {
        defendantName: STRING,
        crime: {
            type: Type.OBJECT,
            required: ["charge", "title", "location", "timeline"],
            properties: {
                charge: STRING,
                title: STRING,
                location: STRING,
                timeline: { type: Type.ARRAY, items: STRING, minItems: "4", maxItems: "6" },
            },
        },
        truth: {
            type: Type.OBJECT,
            required: ["summary", "misleadingEvidenceIds"],
            properties: {
                summary: STRING,
                misleadingEvidenceIds: STRING_LIST,
            },
        },
        evidence: {
            type: Type.ARRAY,
            minItems: String(EVIDENCE_COUNT),
            maxItems: String(EVIDENCE_COUNT),
            items: {
                type: Type.OBJECT,
                required: ["id", "label", "imagePrompt", "visualFacts"],
                properties: {
                    id: STRING,
                    label: STRING,
                    imagePrompt: STRING,
                    visualFacts: { type: Type.ARRAY, items: STRING, minItems: "1", maxItems: "4" },
                },
            },
        },
        witnesses: {
            type: Type.ARRAY,
            minItems: String(WITNESS_COUNT),
            maxItems: String(WITNESS_COUNT),
            items: {
                type: Type.OBJECT,
                required: ["id", "name", "claim", "reliable"],
                properties: {
                    id: STRING,
                    name: STRING,
                    claim: STRING,
                    reliable: { type: Type.BOOLEAN },
                },
            },
        },
    },
};

/**
 * No minItems/maxItems anywhere in here, unlike FACTS_SCHEMA. Constrained
 * decoding has to unroll those bounds, and bounding an array of deeply nested
 * objects (up to 18 nodes, each with up to 3 choices, each with an effects
 * object) exceeds what the endpoint accepts: the whole request comes back
 * 400 INVALID_ARGUMENT before a token is generated. Confirmed by bisection —
 * removing only the bounds turns the same schema into a 200.
 *
 * The counts are asked for in the prompt and enforced by case_validator.ts
 * instead, which is where the real constraint belongs anyway.
 */
export const TREE_SCHEMA: Schema = {
    type: Type.OBJECT,
    required: ["rootNodeId", "nodes", "verdictRules"],
    properties: {
        rootNodeId: STRING,
        nodes: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                required: ["id", "speaker", "statement", "evidenceIds", "choices"],
                properties: {
                    id: STRING,
                    speaker: {
                        type: Type.STRING,
                        format: "enum",
                        enum: ["PROSECUTOR", "JUDGE", "WITNESS"],
                    },
                    statement: STRING,
                    evidenceIds: STRING_LIST,
                    choices: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            required: ["text", "effects", "nextNodeId"],
                            properties: {
                                text: STRING,
                                effects: {
                                    type: Type.OBJECT,
                                    required: [
                                        "doubt",
                                        "credibility",
                                        "suspicion",
                                        "revealsEvidenceIds",
                                    ],
                                    properties: {
                                        doubt: NUMBER,
                                        credibility: NUMBER,
                                        suspicion: NUMBER,
                                        revealsEvidenceIds: STRING_LIST,
                                    },
                                },
                                // The one nullable field in either schema: null is
                                // how a branch says "go to the verdict".
                                nextNodeId: { type: Type.STRING, nullable: true },
                            },
                        },
                    },
                },
            },
        },
        verdictRules: {
            type: Type.OBJECT,
            required: ["acquitAtDoubt", "suspiciousAtSuspicion"],
            properties: {
                acquitAtDoubt: NUMBER,
                suspiciousAtSuspicion: NUMBER,
            },
        },
    },
};

const EVIDENCE_IDS = Array.from({ length: EVIDENCE_COUNT }, (_, index) => `E${index + 1}`);
const WITNESS_IDS = Array.from({ length: WITNESS_COUNT }, (_, index) => `W${index + 1}`);

export function factsPrompt(): string {
    return `You are the case writer for Paw & Order, a comedic courtroom game in which the
player defends their own dog against a fictional charge.

The attached photo is the defendant. Look at it and invent a case around THAT dog.

Rules:
- Invent a name for the dog. Do not use "Baxter".
- The crime must be petty, domestic and harmless: stolen food, a destroyed
  cushion, a missing garden gnome. No violence, no injury, no real crime, no
  people harmed, no other animals harmed.
- charge reads like a docket entry, e.g. "Grand Theft Birthday Cake".
- title reads like a case name, e.g. "The Great Birthday Cake Heist".
- timeline entries are "HH:MM - what happened", in ascending order.
- truth.summary is the hidden reality of what actually happened. It may make the
  dog guilty, innocent, or somewhere in between. It is never shown to the player
  during the trial, so write it plainly rather than coyly.
- truth.misleadingEvidenceIds lists the exhibits that point the wrong way. It may
  be empty.
- Exactly ${String(EVIDENCE_COUNT)} exhibits, with ids exactly ${EVIDENCE_IDS.join(", ")}.
- Exactly ${String(WITNESS_COUNT)} witnesses, with ids exactly ${WITNESS_IDS.join(", ")}.
  At least one witness must be unreliable (reliable: false).

The exhibits are the important part. Each one becomes a real generated image:
- imagePrompt is the instruction for an image model that also receives this same
  dog photo. Describe a photograph: the scene, where the dog is, and every detail
  that must be legible. Say "the dog from the reference photo" rather than naming
  a breed. Ask for no text or captions in the image.
- visualFacts lists what a person would literally SEE in that photograph, one
  fact per entry, in plain language: "white frosting around the dog's mouth",
  "a wall clock reading 14:22". Not conclusions, not intentions, not backstory —
  only what is visible. Everything in visualFacts must be something imagePrompt
  actually asks for.
- At least one exhibit must contain a detail that contradicts a witness claim, so
  the player has something to find.

Return JSON only.`;
}

export function treePrompt(facts: GeneratedFacts): string {
    // truth.summary is deliberately absent. Every statement this model writes is
    // served to the client mid-trial, nothing instructs it to keep a secret, and
    // case_validator.ts cannot check prose - so one prosecutor line paraphrasing
    // the hidden reality would break the invariant with no guard anywhere. Not
    // sending it is the guard. misleadingEvidenceIds is safe to pass: bare ids
    // let the model plant contradictions without carrying the answer in words.
    //
    // It also happens to be truer to the courtroom: the prosecution does not know
    // what really happened either.
    const world = JSON.stringify(
        {
            defendantName: facts.defendantName,
            crime: facts.crime,
            misleadingEvidenceIds: facts.truth.misleadingEvidenceIds,
            evidence: facts.evidence.map((item) => ({
                id: item.id,
                label: item.label,
                visualFacts: item.visualFacts,
            })),
            witnesses: facts.witnesses,
        },
        null,
        2,
    );

    return `You are building the trial tree for a Paw & Order case. The case already
exists and is fixed. Here it is:

${world}

Build the courtroom exchange the player plays through. The player is the defense
attorney; every node is someone speaking TO them, and every choice is what the
player says next.

You have deliberately NOT been told what actually happened. Nobody in this
courtroom knows. misleadingEvidenceIds marks the exhibits that point the wrong
way, and you may build contradictions around them, but do not state or imply a
conclusion about what really happened - not in a statement, not in a choice.

Structure:
- 3 to 5 main questions, each with 1 or 2 levels of follow-up.
- Node ids are "N1", "N2", ... and rootNodeId is the first main question.
- Every node has 2 or 3 choices.
- choices[].nextNodeId is the id of another node, or null to end the trial and go
  to the verdict. At least one choice must be null, and every node must be
  reachable from rootNodeId by following nextNodeId.
- The tree must not loop. A nextNodeId may never lead back to a node already
  passed through.

Hard constraint — this is what the game engine checks:
- evidenceIds may only contain ids from the evidence list above.
- effects.revealsEvidenceIds may only contain ids from the evidence list above.
- A statement may only assert something that appears in that case's visualFacts,
  a witness claim, or the timeline. You may not invent a new visible detail. If
  you want to talk about frosting, frosting must already be a visualFact.

Effects are the player's running state. Each is a delta between -20 and 25:
- doubt: reasonable doubt established. High doubt acquits.
- credibility: how seriously the court takes the defense.
- suspicion: how guilty the dog looks. High suspicion taints an acquittal.
Set acquitAtDoubt between 50 and 70, suspiciousAtSuspicion between 40 and 60.

Design rules:
- No obviously correct choice. Every option trades something: pressing a
  contradiction may raise doubt but cost credibility; conceding may protect
  credibility but raise suspicion.
- A bad choice makes the case harder, it never ends the trial early.
- The prosecutor should be smug, the judge dry. Keep it funny and never cruel.

Return JSON only.`;
}
