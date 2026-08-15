<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { PublicCase } from "@paw-order/shared";

const props = defineProps<{ currentCase: PublicCase }>();
defineEmits<{ enter: []; leave: [] }>();

/** brand.md sets the format; the id is the only real number we have. */
const docket = computed(() => `PAW-${props.currentCase.id.slice(0, 4).toUpperCase()}`);

// The screen the player is thrown to when generation finishes, with no click of
// their own behind it, so focus is sitting on document.body until it is moved.
const headlineRef = ref<HTMLElement | null>(null);
onMounted(() => headlineRef.value?.focus());
</script>

<template>
    <main class="arrest">
        <article class="file">
            <header class="file__head">
                <p class="docket-line">Docket #{{ docket }}</p>
                <p class="docket-line file__status">Status: extremely suspicious</p>
            </header>

            <div class="file__body">
                <figure class="mugshot">
                    <img class="mugshot__photo" :src="currentCase.defendant.photoUrl" alt="" />
                    <figcaption class="mugshot__placard">{{ docket }}</figcaption>
                </figure>

                <div class="file__facts">
                    <!-- tabindex -1 so focus can be moved here on arrival; it
                         is not in the tab order itself. -->
                    <h1 ref="headlineRef" class="file__headline" tabindex="-1">
                        {{ currentCase.defendant.name }} has been arrested
                    </h1>

                    <dl class="record">
                        <dt class="field-label">Charge</dt>
                        <dd class="record__value record__value--charge">
                            {{ currentCase.crime.charge }}
                        </dd>

                        <dt class="field-label">Case</dt>
                        <dd class="record__value">{{ currentCase.crime.title }}</dd>

                        <dt class="field-label">Scene</dt>
                        <dd class="record__value">{{ currentCase.crime.location }}</dd>

                        <dt class="field-label">Counsel</dt>
                        <dd class="record__value">You</dd>
                    </dl>
                </div>
            </div>

            <section class="timeline">
                <h2 class="field-label">The prosecution's timeline</h2>
                <ol class="timeline__list">
                    <!-- Keyed by position: the entries are model prose with no
                         uniqueness constraint, and two identical lines would
                         collide on a text key. -->
                    <li
                        v-for="(entry, index) in currentCase.crime.timeline"
                        :key="`t${index}`"
                        class="timeline__entry"
                    >
                        {{ entry }}
                    </li>
                </ol>
            </section>

            <button class="enter" type="button" @click="$emit('enter')">Enter court</button>
        </article>

        <!-- The only way off this screen that is not "enter court". A replayed
             case lands here with nothing behind it, so without this the way back
             to the strip it was picked from is a reload.

             Last in the document, drawn first by order: -1. Focus lands on the
             headline at mount, so a leave button placed above it in the DOM is
             one the player only reaches by tabbing backwards - past every
             control on the sheet if they tab forwards. -->
        <p class="leave-row">
            <button class="leave" type="button" @click="$emit('leave')">
                &larr; Back to the front desk
            </button>
        </p>
    </main>
</template>

<style scoped>
.arrest {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--step);
}

/* Sits on the same left edge as the file below it, which is what makes it read
   as a way out of this sheet rather than a control on the page. */
.leave-row {
    order: -1;
    width: min(56rem, 100%);
    margin: 0 0 0.6rem;
}

.leave {
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

.leave:hover {
    color: var(--ink);
    text-decoration: underline;
}

.file {
    width: min(56rem, 100%);
    background: var(--paper-shade);
    border: var(--rule);
    border-top: 6px solid var(--ink);
    padding: clamp(1.25rem, 3vw, 2.25rem);
    box-shadow: 0 18px 40px rgb(23 28 38 / 12%);
    animation: file-in 320ms ease-out both;
}

@keyframes file-in {
    from {
        opacity: 0;
        transform: translateY(12px);
    }
}

.file__head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    justify-content: space-between;
    padding-bottom: 0.75rem;
    border-bottom: var(--rule);
}

.file__status {
    color: var(--stamp);
}

.file__body {
    display: flex;
    flex-wrap: wrap;
    gap: clamp(1rem, 3vw, 2rem);
    padding: 1.5rem 0;
}

.mugshot {
    margin: 0;
    flex: 0 0 auto;
    width: min(14rem, 100%);
}

.mugshot__photo {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border: 4px solid var(--ink);
    /* Booking photos are not flattering. */
    filter: grayscale(0.35) contrast(1.08);
}

.mugshot__placard {
    font-family: var(--transcript);
    font-weight: 700;
    letter-spacing: 0.2em;
    text-align: center;
    padding: 0.25rem;
    background: var(--ink);
    color: var(--paper);
}

.file__facts {
    flex: 1 1 18rem;
}

.file__headline:focus {
    outline: none;
}

.file__headline {
    font-family: var(--display);
    font-size: clamp(1.75rem, 1rem + 3vw, 3rem);
    line-height: 1.02;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    margin: 0 0 1.25rem;
}

.record {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.4rem 1.25rem;
    align-items: baseline;
    margin: 0;
}

.record__value {
    margin: 0;
    font-family: var(--transcript);
}

.record__value--charge {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--stamp);
}

.timeline {
    border-top: var(--rule);
    padding-top: 1rem;
}

.timeline__list {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
}

.timeline__entry {
    font-family: var(--transcript);
    font-size: 0.9375rem;
    padding-left: 1rem;
    border-left: 2px solid var(--tape);
}

.enter {
    display: block;
    width: 100%;
    margin-top: 1.75rem;
    padding: 1rem;
    background: var(--ink);
    color: var(--paper);
    border: none;
    font-family: var(--display);
    font-size: 1.125rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    transition:
        background 150ms ease,
        transform 150ms ease;
}

.enter:hover {
    background: var(--stamp);
    transform: translateY(-2px);
}
</style>
