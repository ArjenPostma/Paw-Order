<script setup lang="ts">
import { onUnmounted, ref } from "vue";

/**
 * The generation reports no progress, so this does not pretend to measure one.
 * It types out the clerk's log instead: the stages are real (facts, then
 * exhibit images, then the trial tree) and they are paced to the roughly one
 * minute a case takes. The last line stays up however long the wait runs, which
 * is honest about the slow stage rather than looping back to the start.
 */
const STAGES = [
    "Case file opened",
    "Reviewing the incident",
    "Filing the charge",
    "Photographing the exhibits",
    "Taking witness statements",
    "Scheduling the examination",
];
const STAGE_MS = 9000;

const shown = ref(1);

const timer = setInterval(() => {
    if (shown.value < STAGES.length) {
        shown.value += 1;
    }
}, STAGE_MS);

onUnmounted(() => clearInterval(timer));
</script>

<template>
    <main class="preparing">
        <article class="log">
            <p class="docket-line">Clerk of the court</p>
            <h1 class="log__title">Preparing the case</h1>

            <ol class="log__lines" aria-live="polite">
                <li v-for="stage in STAGES.slice(0, shown)" :key="stage" class="log__line">
                    {{ stage }}
                </li>
            </ol>

            <p class="log__caret" aria-hidden="true">
                <span class="log__cursor"></span>
            </p>

            <p class="log__note">This takes about a minute.</p>
        </article>
    </main>
</template>

<style scoped>
.preparing {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--step);
}

.log {
    width: min(34rem, 100%);
    background: var(--paper-shade);
    border: var(--rule);
    border-top: 6px solid var(--ink);
    padding: clamp(1.5rem, 4vw, 2.5rem);
    box-shadow: 0 18px 40px rgb(23 28 38 / 12%);
}

.log__title {
    font-family: var(--display);
    font-size: clamp(1.5rem, 1rem + 2vw, 2.25rem);
    line-height: 1.05;
    text-transform: uppercase;
    letter-spacing: -0.01em;
    margin: 0.5rem 0 1.5rem;
}

.log__lines {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
}

/* Each stage is struck onto the page the way a typewriter lands a line: it
   arrives, it does not fade in and out. */
.log__line {
    font-family: var(--transcript);
    font-size: 0.9375rem;
    padding-left: 1.5rem;
    position: relative;
    animation: strike 220ms steps(6, end) both;
}

.log__line::before {
    content: "\2713";
    position: absolute;
    left: 0;
    color: var(--filed);
    font-weight: 700;
}

/* The line the clerk has not finished yet: the previous one carries the check,
   this one only carries the cursor. */
.log__line:last-child::before {
    content: "\203A";
    color: var(--stamp);
}

@keyframes strike {
    from {
        opacity: 0;
        transform: translateX(-6px);
    }
}

.log__caret {
    margin: 0.5rem 0 1.5rem;
    padding-left: 1.5rem;
}

.log__cursor {
    display: inline-block;
    width: 0.6rem;
    height: 1.05rem;
    background: var(--ink);
    vertical-align: text-bottom;
    animation: blink 1.05s steps(1, end) infinite;
}

@keyframes blink {
    50% {
        opacity: 0;
    }
}

.log__note {
    font-family: var(--transcript);
    font-size: 0.8125rem;
    color: var(--ink-soft);
    border-top: var(--rule);
    padding-top: 1rem;
    margin: 0;
}

/* The cursor is the only thing still moving when motion is turned down: a
   blink is a caret, not an animation the reader has to track. */
@media (prefers-reduced-motion: reduce) {
    .log__cursor {
        animation: none;
    }
}
</style>
