<script setup lang="ts">
import { ref } from "vue";

defineProps<{ error: string | null }>();
const emit = defineEmits<{ photo: [file: File] }>();

// Drag state is local: nothing above this screen cares that a file is hovering.
const dragging = ref(false);

function take(file: File | undefined): void {
    if (file) {
        emit("photo", file);
    }
}

function onFileChange(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const file = input.files?.[0];
    // Cleared immediately: without this, re-picking the SAME photo fires no
    // change event, so the obvious response to "try another photo" - try the
    // same one again, since the failure is usually transient - does nothing.
    input.value = "";
    take(file);
}

function onDrop(event: DragEvent): void {
    dragging.value = false;
    take(event.dataTransfer?.files[0]);
}
</script>

<template>
    <main class="upload">
        <p class="docket-line upload__docket">Municipal Court &middot; Small Animal Division</p>

        <h1 class="upload__title">
            <span class="upload__paw">Paw</span>
            <span class="upload__amp">&amp;</span>
            <span class="upload__order">Order</span>
        </h1>
        <p class="upload__promise">Justice for every good boy.</p>

        <!-- The label IS the drop zone: one target for click, keyboard and
             drag, so there is no second control to keep in sync. -->
        <label
            class="envelope"
            :class="{ 'envelope--dragging': dragging }"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
        >
            <input class="envelope__input" type="file" accept="image/*" @change="onFileChange" />
            <span class="field-label">Exhibit A &middot; the defendant</span>
            <span class="envelope__action">Choose a dog photo</span>
            <span class="envelope__hint">or drop one here &middot; JPG or PNG, up to 8MB</span>
        </label>

        <p v-if="error" class="upload__error" role="alert">{{ error }}</p>
    </main>
</template>

<style scoped>
.upload {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: var(--step);
    text-align: center;
}

.upload__docket {
    position: absolute;
    top: var(--step);
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
}

.upload__title {
    font-family: var(--display);
    font-size: clamp(3rem, 1.5rem + 11vw, 8.5rem);
    line-height: 0.82;
    letter-spacing: -0.03em;
    text-transform: uppercase;
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
}

/* The ampersand sits in the gap between the two words at a smaller size, the
   way a case name is set on a docket cover: PAW & ORDER, not one flat line. */
.upload__amp {
    font-size: 0.42em;
    color: var(--stamp);
    line-height: 1.1;
}

.upload__promise {
    font-family: var(--transcript);
    letter-spacing: 0.06em;
    color: var(--ink-soft);
    margin: 0 0 1.5rem;
}

.envelope {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    width: min(30rem, 100%);
    padding: 2.5rem 1.5rem;
    background: var(--paper-shade);
    border: 2px dashed var(--ink-soft);
    cursor: pointer;
    transition:
        background 150ms ease,
        border-color 150ms ease,
        transform 150ms ease;
}

/* The envelope flap: two triangles meeting at the top edge. */
.envelope::before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: 3.5rem;
    background:
        linear-gradient(to bottom right, transparent 49.5%, rgb(23 28 38 / 8%) 50%),
        linear-gradient(to bottom left, transparent 49.5%, rgb(23 28 38 / 8%) 50%);
    pointer-events: none;
}

.envelope:hover,
.envelope--dragging {
    background: var(--paper);
    border-color: var(--stamp);
    transform: translateY(-2px);
}

.envelope__input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
}

/* The input is visually hidden, so the ring has to be drawn on the zone that
   stands in for it - not on the input's next sibling, which is one caption. */
.envelope:has(:focus-visible) {
    outline: 3px solid var(--stamp);
    outline-offset: 4px;
}

.envelope__action {
    font-family: var(--display);
    font-size: 1.25rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
}

.envelope__hint {
    font-family: var(--transcript);
    font-size: 0.8125rem;
    color: var(--ink-soft);
}

.upload__error {
    font-family: var(--transcript);
    max-width: 30rem;
    margin: 1rem 0 0;
    padding: 0.5rem 0.75rem;
    color: var(--stamp);
    border-left: 3px solid var(--stamp);
    text-align: left;
}

@media (max-height: 40rem) {
    .upload__docket {
        position: static;
        transform: none;
    }
}
</style>
