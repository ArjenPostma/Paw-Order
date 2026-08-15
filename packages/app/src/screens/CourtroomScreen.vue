<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import type { PublicEvidence, PublicTrialNode, PublicWitness } from "@paw-order/shared";

const props = defineProps<{
    node: PublicTrialNode;
    exhibits: PublicEvidence[];
    witnesses: PublicWitness[];
    charge: string;
    /** The prosecution's version of events, as read on the arrest sheet. */
    timeline: string[];
    defendantName: string;
    /** Which question of the examination this is. Real: the run's own length. */
    question: number;
    turning: boolean;
    error: string | null;
}>();
defineEmits<{ choose: [index: number]; abandon: [] }>();

const SPEAKER_NAMES = {
    PROSECUTOR: "Prosecutor",
    JUDGE: "Judge",
    WITNESS: "Witness",
} as const;

// Focused after every turn. Without it the button that was just pressed is
// destroyed by the re-render and focus falls to document.body, so a keyboard
// player tabs through every exhibit again on each question.
const statementRef = ref<HTMLElement | null>(null);

// The lightbox is a native <dialog> opened with showModal: the focus trap, Esc
// to close, the backdrop and the top layer all come with it, so there is no
// keyboard handling or scroll locking to write here.
const lightboxRef = ref<HTMLDialogElement | null>(null);
const zoomed = ref<PublicEvidence | null>(null);

function openExhibit(exhibit: PublicEvidence): void {
    zoomed.value = exhibit;
    lightboxRef.value?.showModal();
}

/** Clicking the backdrop is a click on the dialog itself, not on its contents. */
function onLightboxClick(event: MouseEvent): void {
    if (event.target === lightboxRef.value) {
        lightboxRef.value?.close();
    }
}

watch(
    () => props.node.id,
    async () => {
        await nextTick();
        statementRef.value?.focus();
    },
);

// The first question needs it too. "Enter court" destroys the button that had
// focus, so without this the opening statement is never announced and a
// keyboard player has to tab in from the top of the document. Not `immediate`
// on the watch above: that runs before mount, when the ref is still null.
onMounted(() => statementRef.value?.focus());
</script>

<template>
    <main class="court">
        <div class="transcript">
            <header class="caption">
                <p class="caption__case">The People vs. {{ defendantName }}</p>
                <p class="caption__charge">{{ charge }}</p>
            </header>

            <div class="page">
                <!-- ONE live region, always mounted. A region only announces
                     when it was already in the accessibility tree before its
                     content changed, so moving this onto the swapped blocks
                     silences it. -->
                <section class="examination" aria-live="polite">
                    <p class="examination__marker">
                        <span class="examination__q">Q.{{ question }}</span>
                        {{ SPEAKER_NAMES[node.speaker] }}
                    </p>

                    <!-- tabindex -1 so focus can be moved here after each turn;
                         it is not in the tab order itself. -->
                    <p ref="statementRef" class="examination__statement" tabindex="-1">
                        {{ node.statement }}
                    </p>

                    <p class="examination__cue">
                        {{ turning ? "The court is considering" : "Counsel responds" }}
                    </p>

                    <ul class="responses" aria-label="Respond">
                        <!-- Keyed by position because the index IS the
                             identifier the api takes back: choices carry no id
                             of their own. -->
                        <li v-for="(choice, index) in node.choices" :key="`${node.id}-${index}`">
                            <!-- aria-disabled, not disabled: a disabled button
                                 leaves the tab order and the accessibility tree
                                 entirely, so an in-flight turn reads as the
                                 controls vanishing. The parent already refuses
                                 a second turn while one is running. -->
                            <button
                                class="response"
                                type="button"
                                :aria-disabled="turning"
                                @click="$emit('choose', index)"
                            >
                                <span class="response__box" aria-hidden="true"></span>
                                <span class="response__text">{{ choice.text }}</span>
                            </button>
                        </li>
                    </ul>

                    <!-- The only way out of the courtroom that does not need a
                         working turn. Without it a request that never resolves
                         leaves `turning` true, every choice refusing, and the
                         "Take another case" button on the verdict screen the
                         player can no longer reach - so recovery is a reload. -->
                    <p v-if="error" class="examination__error" role="alert">
                        {{ error }}
                        <button class="examination__bail" type="button" @click="$emit('abandon')">
                            Abandon this case
                        </button>
                    </p>
                </section>

                <aside class="rail">
                    <h2 class="field-label rail__title">Witnesses</h2>
                    <p v-for="witness in witnesses" :key="witness.id" class="witness">
                        <span class="witness__name">{{ witness.name }}</span>
                        {{ witness.claim }}
                    </p>

                    <!-- Same list the arrest sheet showed, kept in reach: the
                         contradiction a player is hunting is usually between a
                         witness claim and a clock, and sending them back out of
                         the courtroom to re-read the hours is not a puzzle. -->
                    <h2 class="field-label rail__title rail__title--second">
                        The prosecution's timeline
                    </h2>
                    <ol class="rail__timeline">
                        <!-- Keyed by position, as on the arrest sheet: model
                             prose with no uniqueness constraint. -->
                        <li v-for="(entry, index) in timeline" :key="`t${index}`">{{ entry }}</li>
                    </ol>
                </aside>

                <!-- Laid out along the bottom of the page the way exhibits are
                     laid along the front of a bench: the player compares them
                     against each other, which a vertical column made awkward.
                     Only what the trial has put in play - shipping all three up
                     front let a player read the clock against a witness claim
                     and work out who was lying before question one. -->
                <section class="evidence">
                    <h2 class="field-label evidence__title">Exhibits</h2>
                    <p v-if="exhibits.length === 0" class="evidence__empty">
                        Nothing entered into evidence yet.
                    </p>
                    <div v-else class="evidence__strip">
                        <figure v-for="exhibit in exhibits" :key="exhibit.id" class="exhibit">
                            <span class="exhibit__tape" aria-hidden="true"></span>
                            <button
                                v-if="exhibit.imageUrl"
                                class="exhibit__open"
                                type="button"
                                @click="openExhibit(exhibit)"
                            >
                                <img
                                    class="exhibit__image"
                                    :src="exhibit.imageUrl"
                                    :alt="`${exhibit.label}. Enlarge.`"
                                    loading="lazy"
                                />
                            </button>
                            <figcaption class="exhibit__caption">
                                <span class="exhibit__tag">{{ exhibit.id }}</span>
                                {{ exhibit.label }}
                                <ul class="exhibit__facts">
                                    <!-- Keyed by position: visualFacts is model
                                         output with no uniqueness constraint,
                                         and two identical entries collide. -->
                                    <li
                                        v-for="(fact, index) in exhibit.visualFacts"
                                        :key="`${exhibit.id}-${index}`"
                                    >
                                        {{ fact }}
                                    </li>
                                </ul>
                            </figcaption>
                        </figure>
                    </div>
                </section>
            </div>
        </div>

        <dialog ref="lightboxRef" class="lightbox" @click="onLightboxClick" @close="zoomed = null">
            <figure v-if="zoomed" class="lightbox__panel">
                <img class="lightbox__image" :src="zoomed.imageUrl ?? ''" :alt="zoomed.label" />
                <figcaption class="lightbox__caption">
                    <span class="exhibit__tag">{{ zoomed.id }}</span>
                    {{ zoomed.label }}
                </figcaption>
                <button class="lightbox__close" type="button" @click="lightboxRef?.close()">
                    Close exhibit
                </button>
            </figure>
        </dialog>
    </main>
</template>

<style scoped>
.court {
    flex: 1;
    display: flex;
    justify-content: center;
    padding: var(--step);
}

/* The trial is a page in the same case file the arrest and the ruling live in,
   so it is the same sheet: heavy ink rule at the top, manila underneath. */
.transcript {
    /* Capped tight on purpose: a full-width page throws the statement to the
       far left and the exhibits to the far right with a dead gulf between. */
    width: min(60rem, 100%);
    background: var(--paper-shade);
    border: var(--rule);
    border-top: 6px solid var(--ink);
    box-shadow: 0 18px 40px rgb(23 28 38 / 12%);
    padding: clamp(1.25rem, 3vw, 2.25rem);
    align-self: flex-start;
}

.caption {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1.5rem;
    padding-bottom: 0.6rem;
    /* The double rule under a transcript caption. */
    border-bottom: 3px double var(--ink);
}

.caption__case {
    font-family: var(--display);
    font-size: 1rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 0;
}

.caption__charge {
    font-family: var(--transcript);
    font-size: 0.8125rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--stamp);
    margin: 0;
}

.page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 15rem;
    gap: clamp(1.25rem, 2.5vw, 2rem);
    align-items: start;
    padding-top: 1.5rem;
}

.examination__marker {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-family: var(--transcript);
    font-weight: 700;
    font-size: 0.8125rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ink-soft);
    margin: 0 0 0.6rem;
}

/* The question number is the transcript's own margin numbering: it counts the
   run the player has actually taken, not a decorative step counter. */
.examination__q {
    background: var(--ink);
    color: var(--paper);
    letter-spacing: 0.08em;
    padding: 0.1rem 0.4rem;
}

/* The voice the player is listening to gets the largest type on the page. */
.examination__statement {
    font-family: var(--transcript);
    font-size: clamp(1.125rem, 0.95rem + 0.9vw, 1.5rem);
    line-height: 1.5;
    margin: 0 0 2rem;
    padding-left: 1.1rem;
    border-left: 3px solid var(--stamp);
}

.examination__statement:focus {
    outline: none;
}

.examination__cue {
    font-family: var(--transcript);
    font-size: 0.75rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ink-soft);
    margin: 0 0 0.75rem;
}

.responses {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
}

/* Responses are entries on a form, not buttons on a page: a box to tick and
   the words beside it. */
.response {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    text-align: left;
    padding: 0.8rem 0.9rem;
    background: rgb(255 255 255 / 28%);
    color: var(--ink);
    border: 1px solid var(--paper-edge);
    font-size: 1rem;
    line-height: 1.45;
    transition:
        background 140ms ease,
        border-color 140ms ease,
        transform 140ms ease;
}

.response__box {
    flex: 0 0 auto;
    width: 0.85rem;
    height: 0.85rem;
    margin-top: 0.3rem;
    border: 2px solid var(--ink-soft);
    transition:
        background 140ms ease,
        border-color 140ms ease;
}

.response:hover {
    background: rgb(255 255 255 / 55%);
    border-color: var(--ink);
    transform: translateX(3px);
}

.response:hover .response__box {
    background: var(--stamp);
    border-color: var(--stamp);
}

.response[aria-disabled="true"] {
    opacity: 0.5;
    cursor: progress;
}

.examination__error {
    font-family: var(--transcript);
    color: var(--stamp);
    border-left: 3px solid var(--stamp);
    padding-left: 0.75rem;
    margin: 1rem 0 0;
}

.examination__bail {
    display: block;
    margin-top: 0.6rem;
    padding: 0.5rem 0.9rem;
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--ink);
    font-family: var(--transcript);
    font-size: 0.8125rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    transition:
        background 140ms ease,
        color 140ms ease;
}

.examination__bail:hover {
    background: var(--ink);
    color: var(--paper);
}

.rail {
    border-left: var(--rule);
    padding-left: clamp(1rem, 2vw, 1.5rem);
}

.rail__title {
    margin: 0 0 0.75rem;
}

/* Separated from the witness list by the same rule that separates sections of
   the file itself, so the rail reads as two records rather than one long one. */
.rail__title--second {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: var(--rule);
}

.rail__timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
    font-family: var(--transcript);
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--ink-soft);
}

.rail__timeline li {
    padding-left: 0.75rem;
    border-left: 2px solid var(--tape);
}

.witness {
    font-family: var(--transcript);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--ink-soft);
    margin: 0 0 0.75rem;
}

.witness__name {
    display: block;
    color: var(--ink);
    font-weight: 700;
}

.evidence {
    grid-column: 1 / -1;
    border-top: var(--rule);
    padding-top: 1.25rem;
}

.evidence__title {
    margin: 0 0 1rem;
}

.evidence__empty {
    font-family: var(--transcript);
    font-size: 0.8125rem;
    color: var(--ink-soft);
    margin: 0;
}

/* A row along the bench. It scrolls rather than wraps: three exhibits stay
   comparable side by side, and a fourth would otherwise drop to a second row
   nobody looks at. */
.evidence__strip {
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
    overflow-x: auto;
    padding: 0.75rem 0 0.5rem;
}

/* Exhibits are photographs taped into the file, so they sit slightly askew. */
.exhibit {
    position: relative;
    flex: 0 0 13.5rem;
    margin: 0;
    padding: 0.5rem 0.5rem 0.6rem;
    background: rgb(255 255 255 / 45%);
    box-shadow: 0 3px 10px rgb(23 28 38 / 14%);
    transform: rotate(-0.7deg);
    animation: exhibit-in 300ms ease-out both;
}

.exhibit:nth-of-type(even) {
    transform: rotate(0.8deg);
}

.exhibit__tape {
    position: absolute;
    top: -0.55rem;
    left: 50%;
    width: 4.5rem;
    height: 1.1rem;
    transform: translateX(-50%) rotate(-2deg);
    background: rgb(201 162 39 / 55%);
    border-left: 1px solid rgb(201 162 39 / 75%);
    border-right: 1px solid rgb(201 162 39 / 75%);
}

@keyframes exhibit-in {
    from {
        opacity: 0;
        transform: rotate(-4deg) translateY(10px);
    }
}

/* The photograph is the control. A bare button wrapper, so the tile keeps its
   taped-in look and still announces itself to a keyboard. */
.exhibit__open {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    transition: filter 140ms ease;
}

.exhibit__open:hover {
    filter: brightness(1.06);
}

.exhibit__image {
    display: block;
    width: 100%;
}

.lightbox {
    max-width: min(56rem, 92vw);
    max-height: 92vh;
    padding: 0;
    border: none;
    background: none;
    overflow: visible;
}

.lightbox::backdrop {
    background: rgb(20 24 33 / 78%);
}

/* A figure, not a div: the caption below the image is a figcaption, and that
   element is only valid inside a figure. */
.lightbox__panel {
    margin: 0;
    background: var(--paper-shade);
    border-top: 6px solid var(--ink);
    padding: clamp(0.75rem, 2vw, 1.25rem);
    box-shadow: 0 24px 60px rgb(23 28 38 / 45%);
}

.lightbox__image {
    display: block;
    /* The panel's own padding plus the caption and the button below it. */
    max-height: calc(92vh - 9rem);
    max-width: 100%;
    margin: 0 auto;
}

.lightbox__caption {
    font-family: var(--transcript);
    font-size: 0.9375rem;
    padding-top: 0.75rem;
}

.lightbox__close {
    display: block;
    width: 100%;
    margin-top: 0.9rem;
    padding: 0.7rem;
    background: var(--ink);
    color: var(--paper);
    border: none;
    font-family: var(--display);
    font-size: 0.8125rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    transition: background 150ms ease;
}

.lightbox__close:hover {
    background: var(--stamp);
}

.exhibit__caption {
    font-family: var(--transcript);
    font-size: 0.8125rem;
    line-height: 1.45;
    padding-top: 0.45rem;
}

.exhibit__tag {
    display: inline-block;
    background: var(--ink);
    color: var(--paper);
    font-weight: 700;
    padding: 0 0.35rem;
    margin-right: 0.35rem;
}

.exhibit__facts {
    margin: 0.35rem 0 0;
    padding-left: 1rem;
    color: var(--ink-soft);
}

@media (max-width: 52rem) {
    .page {
        grid-template-columns: minmax(0, 1fr);
    }

    .rail {
        border-left: none;
        border-top: var(--rule);
        padding-left: 0;
        padding-top: 1.5rem;
    }
}
</style>
