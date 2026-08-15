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

/** Set once the wait has ended with no case. Null while it is still running. */
defineProps<{ stalled: string | null }>();
defineEmits<{ leave: [] }>();

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
            <h1 class="log__title">{{ stalled ? "Case abandoned" : "Preparing the case" }}</h1>

            <!-- The panel the player has been watching is the panel that owes
                 them the answer, so the log is replaced in place rather than
                 the whole screen falling back to the envelope. -->
            <template v-if="stalled">
                <p class="log__stalled" role="alert">{{ stalled }}</p>
                <button class="log__leave" type="button" @click="$emit('leave')">
                    Take another case
                </button>
            </template>

            <!-- Every stage is rendered from the start and the ones still to
                 come are only made invisible, so the log holds its full height
                 and the panel does not grow a line at a time under the reader.
                 visibility, not opacity: a hidden line is out of the
                 accessibility tree, so the live region announces a stage when
                 it arrives rather than reading all six at mount. -->
            <ol v-else class="log__lines" aria-live="polite">
                <li
                    v-for="(stage, index) in STAGES"
                    :key="stage"
                    class="log__line"
                    :class="{
                        'log__line--pending': index >= shown,
                        'log__line--current': index === shown - 1,
                    }"
                >
                    {{ stage }}
                </li>
            </ol>

            <p v-if="!stalled" class="log__note">This takes about a minute.</p>
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
    /* The spacing the caret paragraph used to hold below the log. */
    margin: 0 0 2rem;
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
}

/* On the visible ones only, so the strike runs when the pending class comes off
   rather than at mount, where it would be spent behind a hidden line. */
.log__line:not(.log__line--pending) {
    animation: strike 220ms steps(6, end) both;
}

.log__line--pending {
    visibility: hidden;
}

.log__line::before {
    content: "\2713";
    position: absolute;
    left: 0;
    color: var(--filed);
    font-weight: 700;
}

/* The line the clerk has not finished yet: the ones above carry the check, this
   one only carries the cursor. Driven by the class rather than :last-child,
   which is now always the sixth stage whether it has arrived or not. */
.log__line--current::before {
    content: "\203A";
    color: var(--stamp);
}

@keyframes strike {
    from {
        opacity: 0;
        transform: translateX(-6px);
    }
}

/* On the line being typed rather than under the block: the stages below it are
   rendered all along to hold the panel's height, so a caret of its own sat at
   the foot of six lines while the clerk was still on the first. */
.log__line--current::after {
    content: "";
    display: inline-block;
    width: 0.6rem;
    height: 1.05rem;
    margin-left: 0.4rem;
    background: var(--ink);
    vertical-align: text-bottom;
    animation: blink 1.05s steps(1, end) infinite;
}

@keyframes blink {
    50% {
        opacity: 0;
    }
}

.log__stalled {
    font-family: var(--transcript);
    font-size: 0.9375rem;
    margin: 0 0 1.5rem;
}

/* The verdict screen's primary action, in the other place a run ends. */
.log__leave {
    width: 100%;
    padding: 0.9rem 1rem;
    background: var(--ink);
    color: var(--paper);
    border: 2px solid var(--ink);
    font-family: var(--display);
    font-size: 0.9375rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    transition:
        background 150ms ease,
        border-color 150ms ease,
        transform 150ms ease;
}

.log__leave:hover {
    background: var(--stamp);
    border-color: var(--stamp);
    transform: translateY(-2px);
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
    .log__line--current::after {
        animation: none;
    }
}
</style>
