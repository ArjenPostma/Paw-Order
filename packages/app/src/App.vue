<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type {
    PublicCase,
    PublicEvidence,
    PublicTrialNode,
    Truth,
    Verdict,
} from "@paw-order/shared";
import { createCase, fetchCase, playTurn } from "@/api";

/**
 * brand.md is the authority for player-facing wording, and gamedesign.md 9
 * spells these four out with their punctuation. A Record rather than a
 * replaceAll over the enum: adding a verdict should be a compile error here,
 * not a de-underscored identifier shipped to a player.
 */
const VERDICT_COPY: Record<Verdict, string> = {
    NOT_GUILTY: "NOT GUILTY",
    NOT_GUILTY_BUT_SUSPICIOUS: "NOT GUILTY, BUT SUSPICIOUS",
    GUILTY_BUT_REASONABLE_DOUBT: "GUILTY, BUT REASONABLE DOUBT",
    GUILTY: "GUILTY",
};

// Infrastructure shell only, deliberately unstyled: proves upload -> generation
// -> poll -> client. The real screens (Landing, Case introduction, Courtroom,
// Verdict) come later.
const POLL_INTERVAL_MS = 2000;
// 3 minutes. Past this the generation is almost certainly a lost background job
// (see the ponytail note in case_service.ts) rather than a slow one.
const POLL_ATTEMPTS = 90;
// A poll runs ~90 times over 3 minutes across the public internet, so a 502 from
// the edge or a moment offline is expected, not exceptional. Giving up on the
// first one throws away a case that is generating perfectly well.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const currentCase = ref<PublicCase | null>(null);
const error = ref<string | null>(null);
const status = ref<"idle" | "preparing" | "ready">("idle");

/**
 * The run. `path` is the whole list of choice indexes taken so far: the api
 * holds the effects table and replays it every turn, so there is no local score
 * to keep and nothing here to tamper with. `node` is whichever node that replay
 * left the player on, and `outcome` is set once the trial ends.
 */
const path = ref<number[]>([]);
const node = ref<PublicTrialNode | null>(null);
// Exhibits the api has unlocked so far. The case no longer arrives with the
// whole set, so this IS the exhibit list, not a list of ids into one.
const exhibits = ref<PublicEvidence[]>([]);
const outcome = ref<{ verdict: Verdict; score: number; truth: Truth } | null>(null);
// One turn in flight at a time: two clicks would otherwise push two indexes and
// send a path the player never chose.
const turning = ref(false);
// Focused after every turn. Without it the button that was just pressed is
// destroyed by the re-render and focus falls to document.body, so a keyboard
// player tabs past the upload field and every exhibit again on each question.
const statementRef = ref<HTMLElement | null>(null);

/**
 * Exhibit labels, not ids: "E2" is a database key, and the label is already on
 * the exhibit the verdict hands back.
 */
const misleadingExhibits = computed(() => {
    const ids = new Set(outcome.value?.truth.misleadingEvidenceIds ?? []);
    return exhibits.value.filter((exhibit) => ids.has(exhibit.id)).map((exhibit) => exhibit.label);
});

async function focusStatement(): Promise<void> {
    await nextTick();
    statementRef.value?.focus();
}

function startTrial(): void {
    path.value = [];
    node.value = currentCase.value?.rootNode ?? null;
    exhibits.value = currentCase.value?.evidence ?? [];
    outcome.value = null;
    // Both of these were missed the first time. A hung turn left `turning` true
    // forever, so a freshly generated case rendered with every choice disabled
    // and no way back; and a failed turn's alert survived into the next run.
    turning.value = false;
    error.value = null;
}

async function choose(index: number): Promise<void> {
    const id = currentCase.value?.id;
    if (!id || turning.value) {
        return;
    }
    // Same guard the poll loop uses: uploading a new photo mid-turn bumps `run`,
    // and without this the in-flight turn resolves afterwards and writes the
    // previous case's trial over the new one.
    const thisRun = run;
    turning.value = true;
    error.value = null;
    // Not pushed onto path until the api accepts it, so a rejected turn leaves
    // the run where it was instead of desynchronised from the server.
    const attempted = [...path.value, index];
    try {
        const turn = await playTurn(id, attempted);
        if (thisRun !== run) {
            return;
        }
        path.value = attempted;
        exhibits.value = turn.evidence;
        if (turn.status === "VERDICT") {
            node.value = null;
            outcome.value = { verdict: turn.verdict, score: turn.score, truth: turn.truth };
        } else {
            node.value = turn.node;
        }
        void focusStatement();
    } catch (cause) {
        if (thisRun !== run) {
            return;
        }
        error.value = cause instanceof Error ? cause.message : "That move did not land.";
    } finally {
        // Unconditional: a superseded turn must still release the buttons, or
        // the new case starts with every choice disabled.
        turning.value = false;
    }
}

// Bumped on every upload so an in-flight poll from a previous photo stops
// instead of overwriting the new case.
let run = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function onFileChange(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const file = input.files?.[0];
    // Cleared immediately: without this, re-picking the SAME photo fires no
    // change event, so the obvious response to "try another photo" - try the
    // same one again, since the failure is usually transient - does nothing.
    input.value = "";
    if (!file) {
        return;
    }

    run += 1;
    const thisRun = run;
    status.value = "preparing";
    error.value = null;
    currentCase.value = null;

    try {
        const accepted = await createCase(file);
        let consecutiveFailures = 0;

        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
            await sleep(POLL_INTERVAL_MS);
            if (thisRun !== run) {
                return;
            }

            // A failed poll is a failed poll, not a failed case: swallow it and
            // ask again. Only a run of them means the api is actually gone.
            let result;
            try {
                result = await fetchCase(accepted.id);
            } catch (pollError) {
                consecutiveFailures += 1;
                if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                    throw pollError;
                }
                continue;
            }
            consecutiveFailures = 0;

            if (result.status === "READY") {
                currentCase.value = result;
                status.value = "ready";
                startTrial();
                return;
            }
            if (result.status === "FAILED") {
                throw new Error("The case fell apart during generation. Try another photo.");
            }
        }
        throw new Error("Preparing the case took too long. Try another photo.");
    } catch (cause) {
        if (thisRun !== run) {
            return;
        }
        error.value = cause instanceof Error ? cause.message : "Upload failed.";
        status.value = "idle";
    }
}
</script>

<template>
    <main>
        <h1>Paw &amp; Order</h1>
        <p>Justice for every good boy.</p>

        <label>
            Dog photo
            <input
                type="file"
                accept="image/*"
                :disabled="status === 'preparing'"
                @change="onFileChange"
            />
        </label>

        <p aria-live="polite">
            {{ status === "preparing" ? "Preparing the case. This takes about a minute..." : "" }}
        </p>
        <p role="alert">{{ error }}</p>

        <section v-if="currentCase">
            <h2>{{ currentCase.crime.title }}</h2>
            <p>DEFENDANT: {{ currentCase.defendant.name }}</p>
            <p>CHARGE: {{ currentCase.crime.charge }}</p>
            <p>LOCATION: {{ currentCase.crime.location }}</p>
            <img :src="currentCase.defendant.photoUrl" alt="The defendant" width="240" />

            <h3>Exhibits</h3>
            <!-- Only what the trial has actually put in play. The case no longer
                 arrives with the full set: reading every exhibit up front let a
                 player cross-reference the clock against a witness claim and
                 work out who was lying before the first question. -->
            <p v-if="exhibits.length === 0">No exhibits entered yet.</p>
            <figure v-for="exhibit in exhibits" :key="exhibit.id">
                <img
                    v-if="exhibit.imageUrl"
                    :src="exhibit.imageUrl"
                    :alt="exhibit.label"
                    width="240"
                    loading="lazy"
                />
                <figcaption>
                    {{ exhibit.id }} — {{ exhibit.label }}
                    <ul>
                        <!-- Keyed by position, not by the text: visualFacts is
                             model output with no uniqueness constraint, and two
                             identical entries would collide. -->
                        <li
                            v-for="(fact, index) in exhibit.visualFacts"
                            :key="`${exhibit.id}-${index}`"
                        >
                            {{ fact }}
                        </li>
                    </ul>
                </figcaption>
            </figure>

            <h3>Witnesses</h3>
            <ul>
                <li v-for="witness in currentCase.witnesses" :key="witness.id">
                    {{ witness.name }}: {{ witness.claim }}
                </li>
            </ul>

            <h3>Examination</h3>
            <!-- ONE live region, always mounted, with the branches inside it. A
                 region only announces when it was already in the accessibility
                 tree before its content changed, so putting aria-live on the
                 two blocks that swap meant the verdict was never announced at
                 all. -->
            <div aria-live="polite">
                <!-- Only the opening node ships with the case; every node after
                     it arrives from POST /api/cases/:id/turn. -->
                <template v-if="node">
                    <!-- tabindex -1 so focus can be moved here after each turn;
                         it is not in the tab order itself. -->
                    <p ref="statementRef" tabindex="-1">{{ node.speaker }}: {{ node.statement }}</p>
                    <p v-if="turning">Objection pending...</p>
                    <ul aria-label="Respond">
                        <!-- Keyed by position because the index IS the
                             identifier the api takes back: choices carry no id
                             of their own. -->
                        <li v-for="(choice, index) in node.choices" :key="`${node.id}-${index}`">
                            <!-- aria-disabled, not disabled: a disabled button
                                 leaves the tab order and the accessibility tree
                                 entirely, so an in-flight turn reads as the
                                 controls vanishing. choose() already refuses a
                                 second turn while one is running. -->
                            <button type="button" :aria-disabled="turning" @click="choose(index)">
                                {{ choice.text }}
                            </button>
                        </li>
                    </ul>
                </template>

                <template v-else-if="outcome">
                    <p ref="statementRef" tabindex="-1">VERDICT</p>
                    <h4>{{ VERDICT_COPY[outcome.verdict] }}</h4>
                    <p>Defense Performance: {{ outcome.score }}/100</p>
                    <!-- The truth is the api's to hand over, and only here: this
                         is the first moment the player is allowed to know it. -->
                    <p>What actually happened: {{ outcome.truth.summary }}</p>
                    <p v-if="misleadingExhibits.length > 0">
                        Exhibits that misled the court: {{ misleadingExhibits.join("; ") }}
                    </p>
                    <button type="button" @click="startTrial">Retry This Case</button>
                </template>
            </div>
        </section>
    </main>
</template>

<style>
body {
    font-family: system-ui, sans-serif;
    margin: 2rem;
}
input[type="file"] {
    cursor: pointer;
}
</style>
