import type { Crime, Evidence, TrialNode, Truth, VerdictRules, Witness } from "@paw-order/shared";

/**
 * Model output is untrusted input. These two functions are the only door it gets
 * through: they narrow `unknown` into the Case Bible's own types and check the
 * things a response schema cannot express — that the trial graph is a reachable,
 * finishable, acyclic set of nodes, and that every id it cites resolves.
 *
 * Errors are collected rather than thrown one at a time, because the whole list
 * goes back into the retry prompt.
 *
 * What this CANNOT check: whether a node's prose actually sticks to the
 * visualFacts it was given. That rule is enforced by the prompt and by handing
 * the tree model nothing else to work from — a statement asserting an invented
 * detail while citing a legitimate evidence id passes here.
 */

export const EVIDENCE_COUNT = 4;
export const WITNESS_COUNT = 2;
/** Bounds one choice's contribution so the running score cannot be blown open. */
const MAX_EFFECT_MAGNITUDE = 25;
/**
 * 3-5 main questions with 1-2 follow-up levels, generously bounded. These live
 * here rather than in TREE_SCHEMA because bounding a nested array there makes
 * the endpoint reject the whole request (see the note on TREE_SCHEMA), so the
 * upper bounds are also the only thing stopping a runaway response from landing
 * in the json column.
 */
const MIN_NODES = 4;
const MAX_NODES = 24;
const MIN_CHOICES = 2;
const MAX_CHOICES = 4;
const SPEAKERS = ["PROSECUTOR", "JUDGE", "WITNESS"] as const;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Stage one: the case itself. `imageUrl` is ours to fill, never the model's. */
export interface GeneratedFacts {
    defendantName: string;
    crime: Crime;
    truth: Truth;
    evidence: Evidence[];
    witnesses: Witness[];
}

/** Stage two: the playable graph. */
export interface GeneratedTree {
    nodes: TrialNode[];
    rootNodeId: string;
    verdictRules: VerdictRules;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilledString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

class Checker {
    readonly errors: string[] = [];

    /** Returns an empty object on failure so callers can keep walking. */
    record(value: unknown, path: string): Record<string, unknown> {
        if (isRecord(value)) {
            return value;
        }
        this.errors.push(`${path} must be an object`);
        return {};
    }

    array(value: unknown, path: string): unknown[] {
        if (Array.isArray(value)) {
            return value;
        }
        this.errors.push(`${path} must be an array`);
        return [];
    }

    string(source: Record<string, unknown>, key: string, path: string): string {
        const value = source[key];
        if (isFilledString(value)) {
            return value.trim();
        }
        this.errors.push(`${path}.${key} must be a non-empty string`);
        return "";
    }

    /** Nullable string: null is meaningful (a choice that ends the trial). */
    nullableString(source: Record<string, unknown>, key: string, path: string): string | null {
        const value = source[key];
        if (value === null || value === undefined) {
            return null;
        }
        if (isFilledString(value)) {
            return value.trim();
        }
        this.errors.push(`${path}.${key} must be a non-empty string or null`);
        return null;
    }

    number(source: Record<string, unknown>, key: string, path: string): number {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        this.errors.push(`${path}.${key} must be a number`);
        return 0;
    }

    boolean(source: Record<string, unknown>, key: string, path: string): boolean {
        const value = source[key];
        if (typeof value === "boolean") {
            return value;
        }
        this.errors.push(`${path}.${key} must be a boolean`);
        return false;
    }

    strings(source: Record<string, unknown>, key: string, path: string): string[] {
        const raw = this.array(source[key], `${path}.${key}`);
        const out: string[] = [];
        raw.forEach((item, index) => {
            if (isFilledString(item)) {
                out.push(item.trim());
            } else {
                this.errors.push(`${path}.${key}[${index}] must be a non-empty string`);
            }
        });
        return out;
    }

    finish<T>(value: T): ValidationResult<T> {
        return this.errors.length === 0 ? { ok: true, value } : { ok: false, errors: this.errors };
    }
}

function toSpeaker(value: unknown): TrialNode["speaker"] | null {
    for (const candidate of SPEAKERS) {
        if (value === candidate) {
            return candidate;
        }
    }
    return null;
}

function clamp(value: number, limit: number): number {
    return Math.max(-limit, Math.min(limit, Math.round(value)));
}

export function validateFacts(value: unknown): ValidationResult<GeneratedFacts> {
    const check = new Checker();
    const root = check.record(value, "facts");

    const crimeSource = check.record(root.crime, "facts.crime");
    const crime: Crime = {
        charge: check.string(crimeSource, "charge", "facts.crime"),
        title: check.string(crimeSource, "title", "facts.crime"),
        location: check.string(crimeSource, "location", "facts.crime"),
        timeline: check.strings(crimeSource, "timeline", "facts.crime"),
    };
    if (crime.timeline.length < 3) {
        check.errors.push("facts.crime.timeline needs at least 3 entries");
    }

    const evidenceSource = check.array(root.evidence, "facts.evidence");
    if (evidenceSource.length !== EVIDENCE_COUNT) {
        check.errors.push(
            `facts.evidence must hold exactly ${String(EVIDENCE_COUNT)} exhibits, got ${String(evidenceSource.length)}`,
        );
    }
    const evidence: Evidence[] = evidenceSource.map((item, index) => {
        const path = `facts.evidence[${String(index)}]`;
        const source = check.record(item, path);
        const visualFacts = check.strings(source, "visualFacts", path);
        if (visualFacts.length === 0) {
            // The trial may only cite what an exhibit shows, so an exhibit that
            // shows nothing is unusable (gamedesign.md §13).
            check.errors.push(`${path}.visualFacts needs at least one visible fact`);
        }
        return {
            id: check.string(source, "id", path),
            label: check.string(source, "label", path),
            imagePrompt: check.string(source, "imagePrompt", path),
            imageUrl: null,
            visualFacts,
        };
    });

    const evidenceIds = new Set(evidence.map((item) => item.id));
    if (evidenceIds.size !== evidence.length) {
        check.errors.push("facts.evidence contains duplicate ids");
    }

    const witnessSource = check.array(root.witnesses, "facts.witnesses");
    if (witnessSource.length !== WITNESS_COUNT) {
        check.errors.push(
            `facts.witnesses must hold exactly ${String(WITNESS_COUNT)} witnesses, got ${String(witnessSource.length)}`,
        );
    }
    const witnesses: Witness[] = witnessSource.map((item, index) => {
        const path = `facts.witnesses[${String(index)}]`;
        const source = check.record(item, path);
        return {
            id: check.string(source, "id", path),
            name: check.string(source, "name", path),
            claim: check.string(source, "claim", path),
            reliable: check.boolean(source, "reliable", path),
        };
    });

    const truthSource = check.record(root.truth, "facts.truth");
    const misleadingEvidenceIds = check.strings(
        truthSource,
        "misleadingEvidenceIds",
        "facts.truth",
    );
    for (const id of misleadingEvidenceIds) {
        if (!evidenceIds.has(id)) {
            check.errors.push(`facts.truth.misleadingEvidenceIds cites unknown exhibit ${id}`);
        }
    }
    const truth: Truth = {
        summary: check.string(truthSource, "summary", "facts.truth"),
        misleadingEvidenceIds,
    };

    return check.finish({
        defendantName: check.string(root, "defendantName", "facts"),
        crime,
        truth,
        evidence,
        witnesses,
    });
}

export function validateTree(
    value: unknown,
    evidence: Evidence[],
): ValidationResult<GeneratedTree> {
    const check = new Checker();
    const root = check.record(value, "tree");
    const knownEvidenceIds = new Set(evidence.map((item) => item.id));

    const citations = (source: Record<string, unknown>, key: string, path: string): string[] => {
        const ids = check.strings(source, key, path);
        for (const id of ids) {
            if (!knownEvidenceIds.has(id)) {
                check.errors.push(`${path}.${key} cites unknown exhibit ${id}`);
            }
        }
        return ids;
    };

    const nodeSource = check.array(root.nodes, "tree.nodes");
    if (nodeSource.length < MIN_NODES || nodeSource.length > MAX_NODES) {
        check.errors.push(
            `tree.nodes must hold between ${String(MIN_NODES)} and ${String(MAX_NODES)} nodes, got ${String(nodeSource.length)}`,
        );
    }

    const nodes: TrialNode[] = nodeSource.map((item, index) => {
        const path = `tree.nodes[${String(index)}]`;
        const source = check.record(item, path);

        const speaker = toSpeaker(source.speaker);
        if (speaker === null) {
            check.errors.push(`${path}.speaker must be one of ${SPEAKERS.join(", ")}`);
        }

        const choiceSource = check.array(source.choices, `${path}.choices`);
        if (choiceSource.length < MIN_CHOICES || choiceSource.length > MAX_CHOICES) {
            check.errors.push(
                `${path}.choices must hold between ${String(MIN_CHOICES)} and ${String(MAX_CHOICES)} options, got ${String(choiceSource.length)}`,
            );
        }

        return {
            id: check.string(source, "id", path),
            // The fallback only ever applies to an already-rejected tree.
            speaker: speaker ?? "PROSECUTOR",
            statement: check.string(source, "statement", path),
            evidenceIds: citations(source, "evidenceIds", path),
            choices: choiceSource.map((rawChoice, choiceIndex) => {
                const choicePath = `${path}.choices[${String(choiceIndex)}]`;
                const choice = check.record(rawChoice, choicePath);
                const effects = check.record(choice.effects, `${choicePath}.effects`);
                return {
                    text: check.string(choice, "text", choicePath),
                    effects: {
                        // Clamped, not rejected: an out-of-range delta is a
                        // usable choice with an unusable magnitude.
                        doubt: clamp(
                            check.number(effects, "doubt", `${choicePath}.effects`),
                            MAX_EFFECT_MAGNITUDE,
                        ),
                        credibility: clamp(
                            check.number(effects, "credibility", `${choicePath}.effects`),
                            MAX_EFFECT_MAGNITUDE,
                        ),
                        suspicion: clamp(
                            check.number(effects, "suspicion", `${choicePath}.effects`),
                            MAX_EFFECT_MAGNITUDE,
                        ),
                        revealsEvidenceIds: citations(
                            effects,
                            "revealsEvidenceIds",
                            `${choicePath}.effects`,
                        ),
                    },
                    nextNodeId: check.nullableString(choice, "nextNodeId", choicePath),
                };
            }),
        };
    });

    const byId = new Map(nodes.map((node) => [node.id, node]));
    if (byId.size !== nodes.length) {
        check.errors.push("tree.nodes contains duplicate ids");
    }

    const rootNodeId = check.string(root, "rootNodeId", "tree");
    if (rootNodeId && !byId.has(rootNodeId)) {
        check.errors.push(`tree.rootNodeId ${rootNodeId} is not a node`);
    }
    for (const node of nodes) {
        for (const choice of node.choices) {
            if (choice.nextNodeId !== null && !byId.has(choice.nextNodeId)) {
                check.errors.push(
                    `tree node ${node.id} points at unknown node ${choice.nextNodeId}`,
                );
            }
        }
    }

    // Walk from the root: anything unreached is dead weight the model invented,
    // and a cycle is a trial the player can never leave. Both are rejections
    // rather than repairs — a pruned tree is a quietly worse game.
    const reached = new Set<string>();
    const onPath = new Set<string>();
    let sawEnding = false;
    let sawCycle = false;

    const walk = (nodeId: string): void => {
        if (onPath.has(nodeId)) {
            sawCycle = true;
            return;
        }
        if (reached.has(nodeId)) {
            return;
        }
        reached.add(nodeId);
        onPath.add(nodeId);
        const node = byId.get(nodeId);
        for (const choice of node?.choices ?? []) {
            if (choice.nextNodeId === null) {
                sawEnding = true;
            } else if (byId.has(choice.nextNodeId)) {
                walk(choice.nextNodeId);
            }
        }
        onPath.delete(nodeId);
    };

    if (rootNodeId && byId.has(rootNodeId)) {
        walk(rootNodeId);
    }
    if (sawCycle) {
        check.errors.push("tree contains a cycle");
    }
    if (!sawEnding) {
        check.errors.push("tree has no choice with nextNodeId null, so the trial never ends");
    }
    for (const node of nodes) {
        if (!reached.has(node.id)) {
            check.errors.push(`tree node ${node.id} is unreachable from the root`);
        }
    }

    const rulesSource = check.record(root.verdictRules, "tree.verdictRules");
    const verdictRules: VerdictRules = {
        acquitAtDoubt: check.number(rulesSource, "acquitAtDoubt", "tree.verdictRules"),
        suspiciousAtSuspicion: check.number(
            rulesSource,
            "suspiciousAtSuspicion",
            "tree.verdictRules",
        ),
    };
    if (verdictRules.acquitAtDoubt <= 0) {
        check.errors.push("tree.verdictRules.acquitAtDoubt must be positive");
    }
    if (verdictRules.suspiciousAtSuspicion <= 0) {
        check.errors.push("tree.verdictRules.suspiciousAtSuspicion must be positive");
    }

    return check.finish({ nodes, rootNodeId, verdictRules });
}
