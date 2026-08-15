<script setup lang="ts">
import { ref } from "vue";
import type { PublicCase } from "@paw-order/shared";
import { createCase, fetchCase } from "@/api";

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
            <figure v-for="exhibit in currentCase.evidence" :key="exhibit.id">
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

            <h3>Opening statement</h3>
            <!-- Only the opening node ships now; the rest of the trial arrives
                 a node at a time from POST /api/cases/:id/turn. -->
            <p>
                {{ currentCase.rootNode.speaker }}:
                {{ currentCase.rootNode.statement }}
            </p>
            <ol>
                <!-- Keyed by position because the index IS the identifier the
                     api takes back: choices carry no id of their own. -->
                <li
                    v-for="(choice, index) in currentCase.rootNode.choices"
                    :key="`${currentCase.rootNode.id}-${index}`"
                >
                    {{ choice.text }}
                </li>
            </ol>
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
