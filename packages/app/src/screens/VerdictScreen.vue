<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { PublicEvidence, Truth, Verdict } from "@paw-order/shared";
import ShareLink from "@/components/ShareLink.vue";

const props = defineProps<{
    verdict: Verdict;
    score: number;
    truth: Truth;
    exhibits: PublicEvidence[];
    defendantName: string;
    /** Null when the case was not entered into the public record: no link. */
    slug: string | null;
}>();
defineEmits<{ again: []; newCase: [] }>();

/**
 * brand.md is the authority for player-facing wording, and gamedesign.md 9
 * spells the four verdicts out with their punctuation. A Record rather than a
 * replaceAll over the enum: adding a verdict should be a compile error here,
 * not a de-underscored identifier shipped to a player.
 */
const VERDICT_COPY: Record<Verdict, { headline: string; line: string; acquitted: boolean }> = {
    NOT_GUILTY: {
        headline: "Not guilty",
        line: "free to commit additional crimes.",
        acquitted: true,
    },
    NOT_GUILTY_BUT_SUSPICIOUS: {
        headline: "Not guilty, but suspicious",
        line: "walks out. Nobody in this room is convinced.",
        acquitted: true,
    },
    GUILTY_BUT_REASONABLE_DOUBT: {
        headline: "Guilty, but reasonable doubt",
        line: "is convicted, and the court is not comfortable about it.",
        acquitted: false,
    },
    GUILTY: {
        headline: "Guilty",
        line: "is convicted on every count. Sentence: no treats.",
        acquitted: false,
    },
};

const copy = computed(() => VERDICT_COPY[props.verdict]);

/**
 * Exhibit labels, not ids: "E2" is a database key, and the label is already on
 * the exhibit the verdict hands back.
 */
const misleading = computed(() => {
    const ids = new Set(props.truth.misleadingEvidenceIds);
    return props.exhibits.filter((exhibit) => ids.has(exhibit.id)).map((exhibit) => exhibit.label);
});

const headlineRef = ref<HTMLElement | null>(null);
onMounted(() => headlineRef.value?.focus());
</script>

<template>
    <main class="verdict">
        <article class="ruling" aria-live="polite">
            <p class="docket-line">Court adjourned</p>

            <!-- The one bold moment in the whole game: the ruling lands as a
                 stamp on the file rather than as a heading. -->
            <h1
                ref="headlineRef"
                class="stamp"
                :class="copy.acquitted ? 'stamp--free' : 'stamp--convicted'"
                tabindex="-1"
            >
                {{ copy.headline }}
            </h1>

            <p class="ruling__line">{{ defendantName }} {{ copy.line }}</p>

            <section class="performance">
                <h2 class="field-label">Defense performance</h2>
                <p class="performance__score">
                    {{ score }}<span class="performance__total">/100</span>
                </p>
                <div class="performance__bar">
                    <div class="performance__fill" :style="{ width: `${score}%` }"></div>
                </div>
            </section>

            <section class="truth">
                <h2 class="field-label">What actually happened</h2>
                <p class="truth__summary">{{ truth.summary }}</p>
                <p v-if="misleading.length > 0" class="truth__misleading">
                    Exhibits that misled the court: {{ misleading.join("; ") }}
                </p>
            </section>

            <div class="actions">
                <button class="actions__primary" type="button" @click="$emit('newCase')">
                    Take another case
                </button>
                <button class="actions__secondary" type="button" @click="$emit('again')">
                    Argue this one again
                </button>
            </div>

            <!-- Below the two buttons, not among them: sharing is not another
                 way to keep playing. The link is to the case, so whoever opens
                 it gets their own trial and their own verdict. -->
            <p v-if="slug" class="share-row">
                <ShareLink :slug="slug" />
            </p>
        </article>
    </main>
</template>

<style scoped>
.verdict {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--step);
}

.ruling {
    width: min(44rem, 100%);
    background: var(--paper-shade);
    border: var(--rule);
    border-top: 6px solid var(--ink);
    padding: clamp(1.5rem, 4vw, 3rem);
    box-shadow: 0 18px 40px rgb(23 28 38 / 12%);
    text-align: center;
}

.stamp {
    display: inline-block;
    font-family: var(--display);
    font-size: clamp(1.5rem, 0.6rem + 4vw, 3rem);
    line-height: 1;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    margin: 1rem 0 1.5rem;
    padding: 0.6rem 1.25rem;
    border: 5px solid currentcolor;
    /* The stamp's second ring is a shadow, not an outline: an outline here
       would be overwritten the moment the element takes focus. */
    box-shadow:
        0 0 0 4px var(--paper-shade),
        0 0 0 5px currentcolor;
    transform: rotate(-4deg);
    /* Ink never lands evenly on paper. */
    opacity: 0.88;
    animation: slam 320ms cubic-bezier(0.2, 1.4, 0.4, 1) both;
}

/* Focused programmatically after the ruling, so the player's screen reader
   lands on it; it is not in the tab order and needs no ring of its own. */
.stamp:focus {
    outline: none;
}

.stamp--free {
    color: var(--filed);
}

.stamp--convicted {
    color: var(--stamp);
}

@keyframes slam {
    from {
        opacity: 0;
        transform: rotate(-14deg) scale(2.6);
    }

    to {
        opacity: 0.88;
        transform: rotate(-4deg) scale(1);
    }
}

.ruling__line {
    font-family: var(--transcript);
    font-size: 1.0625rem;
    margin: 0 0 2rem;
}

.performance,
.truth {
    border-top: var(--rule);
    padding-top: 1.25rem;
    margin-bottom: 1.25rem;
    text-align: left;
}

.performance__score {
    font-family: var(--display);
    font-size: 3rem;
    line-height: 1;
    margin: 0.35rem 0 0.75rem;
}

.performance__total {
    font-size: 1.25rem;
    color: var(--ink-soft);
}

.performance__bar {
    height: 0.5rem;
    background: rgb(23 28 38 / 12%);
}

.performance__fill {
    height: 100%;
    background: var(--ink);
    animation: fill 520ms 200ms ease-out both;
    transform-origin: left;
}

@keyframes fill {
    from {
        transform: scaleX(0);
    }
}

.truth__summary {
    font-family: var(--transcript);
    margin: 0.35rem 0 0;
}

.truth__misleading {
    font-family: var(--transcript);
    font-size: 0.875rem;
    color: var(--ink-soft);
    margin: 0.75rem 0 0;
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
}

.share-row {
    margin: 0.75rem 0 0;
}

.actions__primary,
.actions__secondary {
    flex: 1 1 12rem;
    padding: 0.9rem 1rem;
    font-family: var(--display);
    font-size: 0.9375rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    border: 2px solid var(--ink);
    transition:
        background 150ms ease,
        color 150ms ease,
        transform 150ms ease;
}

.actions__primary {
    background: var(--ink);
    color: var(--paper);
}

.actions__secondary {
    background: transparent;
    color: var(--ink);
}

.actions__primary:hover,
.actions__secondary:hover {
    background: var(--stamp);
    border-color: var(--stamp);
    color: var(--paper);
    transform: translateY(-2px);
}
</style>
