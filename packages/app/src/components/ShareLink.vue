<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

/**
 * The link to one case, on the two screens that hold a case: the arrest sheet
 * and the verdict.
 *
 * Only rendered when the case has a slug, which only a case entered into the
 * public record has - so there is no state here for "this cannot be shared".
 */
const props = defineProps<{ slug: string }>();

/** Long enough to read the confirmation, short enough not to look stuck. */
const CONFIRMATION_MS = 2000;

const state = ref<"idle" | "copied" | "failed">("idle");
let timer: ReturnType<typeof setTimeout> | undefined;

// window.location.origin, not VITE_API_URL: this is a link to the app, and the
// app and the api are separate origins in production.
const url = computed(() => `${window.location.origin}/case/${props.slug}`);

async function copy(): Promise<void> {
    clearTimeout(timer);
    try {
        await navigator.clipboard.writeText(url.value);
        state.value = "copied";
    } catch {
        // The clipboard api is missing outside a secure context, and throws
        // when the browser refuses the write. Neither is worth an error: the
        // url is on screen and in the address bar, so it falls back to showing
        // the thing the button was going to copy.
        state.value = "failed";
    }
    timer = setTimeout(() => {
        state.value = "idle";
    }, CONFIRMATION_MS);
}

/** Narrowed rather than cast: the target of a focus event is an EventTarget. */
function selectAll(event: FocusEvent): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
        input.select();
    }
}

onBeforeUnmount(() => {
    clearTimeout(timer);
});
</script>

<template>
    <div class="share">
        <button class="share__button" type="button" @click="copy">
            {{ state === "copied" ? "Copied to clipboard" : "Share the file" }}
        </button>
        <!-- Only when the copy did not happen. Readonly and selected on focus,
             so the fallback is one keystroke rather than a careful drag. -->
        <input
            v-if="state === 'failed'"
            class="share__url"
            type="text"
            readonly
            :value="url"
            aria-label="Link to this case"
            @focus="selectAll"
        />
    </div>
</template>

<style scoped>
.share {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
}

/* The arrest sheet's quiet action, not the primary one: sharing never competes
   with entering court. */
.share__button {
    padding: 0.25rem 0;
    background: none;
    border: none;
    color: var(--ink-soft);
    font-family: var(--transcript);
    font-size: 0.8125rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    transition: color 140ms ease;
}

.share__button:hover {
    color: var(--ink);
    text-decoration: underline;
}

.share__url {
    flex: 1 1 16rem;
    padding: 0.35rem 0.5rem;
    background: var(--paper-shade);
    color: var(--ink);
    border: 1px solid var(--paper-edge);
    font-family: var(--transcript);
    font-size: 0.75rem;
}
</style>
