<script setup lang="ts">
import { ref } from "vue";
import type { PublicCase } from "@paw-order/shared";
import { createCase } from "@/api";

// Infrastructure shell only: proves upload -> api -> R2 -> Postgres -> client.
// The real screens (Landing, Case introduction, Courtroom, Verdict) come later.
const currentCase = ref<PublicCase | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

async function onFileChange(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const file = input.files?.[0];
    if (!file) {
        return;
    }

    busy.value = true;
    error.value = null;
    try {
        currentCase.value = await createCase(file);
    } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "Upload failed.";
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <main>
        <h1>Paw &amp; Order</h1>
        <p>Justice for every good boy.</p>

        <label>
            Dog photo
            <input type="file" accept="image/*" :disabled="busy" @change="onFileChange" />
        </label>

        <p aria-live="polite">{{ busy ? "Filing charges..." : "" }}</p>
        <p role="alert">{{ error }}</p>

        <section v-if="currentCase">
            <h2>{{ currentCase.crime.title }}</h2>
            <p>DEFENDANT: {{ currentCase.defendant.name }}</p>
            <p>CHARGE: {{ currentCase.crime.charge }}</p>
            <img :src="currentCase.defendant.photoUrl" alt="The defendant" width="240" />
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
