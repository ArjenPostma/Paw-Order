<script setup lang="ts">
import { computed, ref } from "vue";
import type {
    PublicCase,
    PublicEvidence,
    PublicTrialNode,
    Truth,
    Verdict,
} from "@paw-order/shared";
import { ApiError, createCase, fetchCase, playTurn } from "@/api";
import { forgetCase, playedCases, rememberCase } from "@/history";
import ArrestScreen from "@/screens/ArrestScreen.vue";
import CourtroomScreen from "@/screens/CourtroomScreen.vue";
import PreparingScreen from "@/screens/PreparingScreen.vue";
import UploadScreen from "@/screens/UploadScreen.vue";
import VerdictScreen from "@/screens/VerdictScreen.vue";

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
const preparing = ref(false);

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
// The arrest screen is a beat, not a state the api knows about: a ready case
// waits here until the player enters court.
const entered = ref(false);
// The "cases on file" strip, held here rather than read by the upload screen, so
// that dropping a dead case updates the list without remounting the screen and
// wiping whatever the player had typed into the defendant name field.
const previous = ref(playedCases());

/** The one place a READY case becomes the case being played. */
function openCase(ready: PublicCase): void {
    currentCase.value = ready;
    entered.value = false;
    preparing.value = false;
    rememberCase({
        id: ready.id,
        name: ready.defendant.name,
        title: ready.crime.title,
        charge: ready.crime.charge,
        photoUrl: ready.defendant.photoUrl,
    });
    previous.value = playedCases();
}

/**
 * Replays a case the player already paid a generation for. No poll: the case is
 * READY or it is gone, and a gone case is dropped from the strip rather than
 * left there to fail again on the next click.
 */
async function onReplay(id: string): Promise<void> {
    run += 1;
    const thisRun = run;
    error.value = null;

    try {
        const result = await fetchCase(id);
        if (thisRun !== run) {
            return;
        }
        if (result.status !== "READY") {
            dropCase(id);
            return;
        }
        openCase(result);
    } catch (cause) {
        if (thisRun !== run) {
            return;
        }
        // A 404 means the case is gone for good; anything else may be the
        // network, so only the miss drops the tile.
        if (cause instanceof ApiError && cause.status === 404) {
            dropCase(id);
            return;
        }
        error.value = cause instanceof Error ? cause.message : "That case would not open.";
    }
}

/** A case the api will not serve again: off the strip, and say so once. */
function dropCase(id: string): void {
    forgetCase(id);
    previous.value = playedCases();
    error.value = "That case is no longer on file.";
}

/** gamedesign.md 14: one screen at a time, in order. */
const screen = computed(() => {
    if (preparing.value) {
        return "preparing";
    }
    if (!currentCase.value) {
        return "upload";
    }
    if (!entered.value) {
        return "arrest";
    }
    return outcome.value ? "verdict" : "courtroom";
});

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

function enterCourt(): void {
    startTrial();
    entered.value = true;
}

/** Back to the envelope. The api holds no run state, so nothing to tear down. */
function takeAnotherCase(): void {
    run += 1;
    currentCase.value = null;
    entered.value = false;
    outcome.value = null;
    node.value = null;
    exhibits.value = [];
    error.value = null;
    preparing.value = false;
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

async function onPhoto(file: File, name: string): Promise<void> {
    run += 1;
    const thisRun = run;
    preparing.value = true;
    error.value = null;
    currentCase.value = null;
    entered.value = false;

    try {
        const accepted = await createCase(file, name);
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
                openCase(result);
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
        preparing.value = false;
    }
}
</script>

<template>
    <UploadScreen
        v-if="screen === 'upload'"
        :error="error"
        :previous="previous"
        @photo="onPhoto"
        @replay="onReplay"
    />

    <PreparingScreen v-else-if="screen === 'preparing'" />

    <ArrestScreen
        v-else-if="screen === 'arrest' && currentCase"
        :current-case="currentCase"
        @enter="enterCourt"
        @leave="takeAnotherCase"
    />

    <CourtroomScreen
        v-else-if="screen === 'courtroom' && currentCase && node"
        :node="node"
        :exhibits="exhibits"
        :witnesses="currentCase.witnesses"
        :charge="currentCase.crime.charge"
        :timeline="currentCase.crime.timeline"
        :defendant-name="currentCase.defendant.name"
        :question="path.length + 1"
        :turning="turning"
        :error="error"
        @choose="choose"
        @abandon="takeAnotherCase"
    />

    <VerdictScreen
        v-else-if="screen === 'verdict' && currentCase && outcome"
        :verdict="outcome.verdict"
        :score="outcome.score"
        :truth="outcome.truth"
        :exhibits="exhibits"
        :defendant-name="currentCase.defendant.name"
        @again="enterCourt"
        @new-case="takeAnotherCase"
    />
</template>
