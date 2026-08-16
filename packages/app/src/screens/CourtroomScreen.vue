<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PublicEvidence, PublicTrialNode, PublicWitness } from "@paw-order/shared";
import CaseTimeline from "@/components/CaseTimeline.vue";

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

/**
 * The one-column layout, at the same width the stylesheet below switches at.
 * The breakpoint is in both places because those sections do not merely restyle
 * there - they move into the sheet, and a Teleport cannot read a media query.
 */
const oneColumn = window.matchMedia("(max-width: 52rem)");
const narrow = ref(oneColumn.matches);

/**
 * Which drawer of the file is open on the phone, or null for none. On one
 * column the exhibits and the witness statements sit a screen below the
 * responses, where a player answering questions never meets them, so there they
 * move into a sheet the bar along the bottom raises. The timeline stays on the
 * page: it is the one thing here the arrest sheet already showed.
 */
const sheet = ref<"exhibits" | "witnesses" | null>(null);
const sheetRef = ref<HTMLDialogElement | null>(null);

// One definition, rendered twice: once along the bottom of the courtroom and
// once inside the sheet, which is the only one of the two reachable while the
// sheet is up - the sheet is in the top layer and its backdrop covers the bar.
const tabs = computed(
    () =>
        [
            { key: "exhibits", label: "Exhibits", count: props.exhibits.length },
            { key: "witnesses", label: "Witnesses", count: props.witnesses.length },
        ] as const,
);

/**
 * The exhibits that have arrived since the drawer was last open, and the line
 * that says one has. A tab counting up from (1) to (2) is not something anyone
 * notices with a question on screen, and an exhibit entering mid-trial is the
 * one event here the player has to act on.
 */
const announced = new Set(props.exhibits.map((exhibit) => exhibit.id));
const unseen = ref(0);
const entered = ref<string | null>(null);
/** Long enough to read a line of it, short enough not to sit over the answer. */
const ENTERED_MS = 7000;
let enteredTimer: ReturnType<typeof setTimeout> | undefined;

watch(
    () => props.exhibits,
    (list) => {
        // The api sends the whole revealed set every turn, so "new" is whatever
        // this component has not already said out loud.
        const fresh = list.filter((exhibit) => !announced.has(exhibit.id));
        if (fresh.length === 0) {
            return;
        }
        for (const exhibit of fresh) {
            announced.add(exhibit.id);
        }
        unseen.value += fresh.length;
        entered.value = `New evidence: ${fresh.map((exhibit) => `${exhibit.id} ${exhibit.label}`).join(" · ")}`;
        clearTimeout(enteredTimer);
        enteredTimer = setTimeout(() => (entered.value = null), ENTERED_MS);
    },
);

/** Tapping the tab that is already up closes the sheet, the way a drawer shuts. */
function toggleSheet(which: "exhibits" | "witnesses"): void {
    if (which === "exhibits") {
        unseen.value = 0;
    }
    if (sheet.value === which) {
        sheetRef.value?.close();
        return;
    }
    sheet.value = which;
    // showModal throws on an already-open dialog, and switching tabs from
    // inside the sheet does exactly that.
    if (sheetRef.value?.open !== true) {
        sheetRef.value?.showModal();
    }
}

function onLayoutChange(event: MediaQueryListEvent): void {
    narrow.value = event.matches;
    // On the wide layout the contents teleport back onto the page, so a sheet
    // left open there is an empty modal over a page already showing them.
    if (!event.matches) {
        sheetRef.value?.close();
    }
}

oneColumn.addEventListener("change", onLayoutChange);
onBeforeUnmount(() => {
    oneColumn.removeEventListener("change", onLayoutChange);
    clearTimeout(enteredTimer);
});

// The lightbox is a native <dialog> opened with showModal: the focus trap, Esc
// to close, the backdrop and the top layer all come with it, so there is no
// keyboard handling or scroll locking to write here.
const lightboxRef = ref<HTMLDialogElement | null>(null);
const zoomed = ref<PublicEvidence | null>(null);

/**
 * Starts the full exhibit downloading on hover or focus, so the lightbox opens
 * on a cached image rather than a cold fetch. The strip only holds the small
 * copy now, so without this the first thing an opened exhibit shows is nothing.
 * Only on intent, never up front: a player who opens none should pay for none.
 */
function warmExhibit(exhibit: PublicEvidence): void {
    if (exhibit.imageUrl) {
        new Image().src = exhibit.imageUrl;
    }
}

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

function onSheetClick(event: MouseEvent): void {
    if (event.target === sheetRef.value) {
        sheetRef.value?.close();
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
                <!-- The questioning and the exhibits, in that order, as one
                     column: the exhibits belong under the responses the player
                     is choosing between, not under whichever of the two columns
                     ran longer. -->
                <div class="column">
                    <!-- ONE live region, always mounted. A region only announces
                         when it was already in the accessibility tree before its
                         content changed, so moving this onto the swapped blocks
                         silences it. -->
                    <section class="examination" aria-live="polite">
                        <p class="examination__marker">
                            <span class="examination__q">Q.{{ question }}</span>
                            {{ SPEAKER_NAMES[node.speaker] }}
                        </p>

                        <!-- The frame holds the reserved five lines and does the
                             scrolling; the statement inside it is only as tall
                             as what was said, so the red rule beside it measures
                             the speech rather than the reservation.

                             tabindex -1 on the frame, not the statement: focus
                             is moved here after each turn and it is the frame
                             that scrolls, so this is what arrow keys must act
                             on. It is not in the tab order itself. -->
                        <div ref="statementRef" class="examination__frame" tabindex="-1">
                            <p class="examination__statement">{{ node.statement }}</p>
                        </div>

                        <p class="examination__cue">
                            {{ turning ? "The court is considering" : "Counsel responds" }}
                        </p>

                        <ul class="responses" aria-label="Respond">
                            <!-- Keyed by position because the index IS the
                                 identifier the api takes back: choices carry no
                                 id of their own. -->
                            <li
                                v-for="(choice, index) in node.choices"
                                :key="`${node.id}-${index}`"
                            >
                                <!-- aria-disabled, not disabled: a disabled
                                     button leaves the tab order and the
                                     accessibility tree entirely, so an in-flight
                                     turn reads as the controls vanishing. The
                                     parent already refuses a second turn while
                                     one is running. -->
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

                        <p v-if="error" class="examination__error" role="alert">
                            {{ error }}
                        </p>
                    </section>

                    <!-- Always mounted and never v-if'd, for the reason the
                         examination above is: a live region only speaks when it
                         was already in the tree before its text changed. -->
                    <p class="entered" :class="{ 'entered--on': entered }" role="status">
                        {{ entered }}
                    </p>

                    <!-- Laid out along a row the way exhibits are laid along the
                         front of a bench: the player compares them against each
                         other, which a vertical column made awkward. Only what
                         the trial has put in play - shipping all three up front
                         let a player read the clock against a witness claim and
                         work out who was lying before question one.

                         On one column this whole section is in the sheet, so the
                         markup is written once and moved. `defer` because the
                         sheet it lands in is further down this template. -->
                    <Teleport defer to="#sheet-exhibits" :disabled="!narrow">
                        <section class="evidence">
                            <h2 class="field-label evidence__title">Exhibits</h2>
                            <p v-if="exhibits.length === 0" class="evidence__empty">
                                Nothing entered into evidence yet.
                            </p>
                            <div v-else class="evidence__strip">
                                <figure
                                    v-for="exhibit in exhibits"
                                    :key="exhibit.id"
                                    class="exhibit"
                                >
                                    <span class="exhibit__tape" aria-hidden="true"></span>
                                    <button
                                        v-if="exhibit.imageUrl"
                                        class="exhibit__open"
                                        type="button"
                                        @click="openExhibit(exhibit)"
                                        @mouseenter="warmExhibit(exhibit)"
                                        @focus="warmExhibit(exhibit)"
                                    >
                                        <!-- The strip copy when the generator wrote
                                         one; cases from before it existed still
                                         have only the full exhibit. The lightbox
                                         below always opens the full one. -->
                                        <img
                                            class="exhibit__image"
                                            :src="exhibit.thumbUrl ?? exhibit.imageUrl"
                                            :alt="`${exhibit.label}. Enlarge.`"
                                            loading="lazy"
                                        />
                                    </button>
                                    <figcaption class="exhibit__caption">
                                        <span class="exhibit__tag">{{ exhibit.id }}</span>
                                        {{ exhibit.label }}
                                        <ul class="exhibit__facts">
                                            <!-- Keyed by position: visualFacts is
                                             model output with no uniqueness
                                             constraint, and two identical
                                             entries collide. -->
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
                    </Teleport>
                </div>

                <aside class="rail">
                    <!-- Heading and cards move together: left behind, the
                         heading would label an empty rail on one column. -->
                    <Teleport defer to="#sheet-witnesses" :disabled="!narrow">
                        <h2 class="field-label rail__title">Witnesses</h2>
                        <!-- One card per statement, each with its own name plate.
                             As paragraphs these ran into the timeline below them,
                             and telling two witnesses apart is the whole job of
                             this rail: the contradiction the player is hunting is
                             between one of these and a clock. -->
                        <article v-for="witness in witnesses" :key="witness.id" class="witness">
                            <h3 class="witness__name">{{ witness.name }}</h3>
                            <p class="witness__claim">{{ witness.claim }}</p>
                        </article>
                    </Teleport>

                    <!-- Same list the arrest sheet showed, kept in reach: the
                         contradiction a player is hunting is usually between a
                         witness claim and a clock, and sending them back out of
                         the courtroom to re-read the hours is not a puzzle. -->
                    <h2 class="field-label rail__title rail__title--second">
                        The prosecution's timeline
                    </h2>
                    <CaseTimeline :entries="timeline" />
                </aside>
            </div>
        </div>

        <!-- Same control the arrest sheet carries, in the same place, for the
             same reason: a run in progress had no way back to the strip except
             a reload. It is also the way out of a turn that never resolves,
             which leaves `turning` true and every choice refusing.

             Last in the document, drawn first by order: -1, exactly as on the
             arrest sheet - focus is moved to the statement on mount and after
             every turn, so a control placed above it in the DOM is one the
             player only reaches by tabbing backwards. -->
        <p class="leave-row">
            <button class="leave" type="button" @click="$emit('abandon')">
                &larr; Abandon this case
            </button>
        </p>

        <!-- The two drawers of the file, along the bottom of the phone. Drawn
             only on one column; on the wide layout both sections are already on
             the page beside the responses. -->
        <nav class="drawers" aria-label="Case file">
            <button
                v-for="tab in tabs"
                :key="tab.key"
                class="drawers__tab"
                :class="{ 'drawers__tab--fresh': tab.key === 'exhibits' && unseen > 0 }"
                type="button"
                :disabled="tab.count === 0"
                :aria-expanded="sheet === tab.key"
                @click="toggleSheet(tab.key)"
            >
                {{ tab.label }} ({{ tab.count }})
            </button>
        </nav>

        <!-- A native dialog again, for the same reasons the lightbox is one: the
             focus trap, Esc, the backdrop and the top layer are all free. An
             exhibit opened from in here puts the lightbox on top of it, which is
             what the top layer does with the later showModal. -->
        <dialog ref="sheetRef" class="sheet" @click="onSheetClick" @close="sheet = null">
            <div class="sheet__panel">
                <div class="sheet__bar">
                    <button
                        v-for="tab in tabs"
                        :key="tab.key"
                        class="drawers__tab"
                        type="button"
                        :disabled="tab.count === 0"
                        :aria-expanded="sheet === tab.key"
                        @click="toggleSheet(tab.key)"
                    >
                        {{ tab.label }} ({{ tab.count }})
                    </button>
                    <button class="sheet__close" type="button" @click="sheetRef?.close()">
                        Close
                    </button>
                </div>

                <!-- The landing places. Empty on the wide layout, where the
                     Teleports above are disabled and their contents stay on the
                     page - and the sheet is never opened there. -->
                <div v-show="sheet === 'exhibits'" id="sheet-exhibits" class="sheet__body"></div>
                <div v-show="sheet === 'witnesses'" id="sheet-witnesses" class="sheet__body"></div>
            </div>
        </dialog>

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
    flex-direction: column;
    align-items: center;
    padding: var(--step);
}

/* Same ghost link the arrest sheet uses, sitting above the page rather than on
   it: it is a way out of the file, not a move inside it. */
.leave-row {
    order: -1;
    width: min(60rem, 100%);
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

/* The questioning and the exhibits are ONE cell, stacked, not two grid rows.
   As rows they were sized alongside the rail, and the rail is almost always the
   taller column - three long witness statements over a six entry timeline - so
   the exhibits were pushed down past a screen of blank paper to clear it. In
   one cell the rail's length cannot move them: they sit under the responses
   whatever the witnesses had to say. */
.column {
    display: flex;
    flex-direction: column;
    /* Vertical rhythm inside the sheet, not the grid's column gap. */
    gap: 1.5rem;
    /* Without this a wide exhibit strip widens the column instead of scrolling
       inside it, and the rail is squeezed to nothing. */
    min-width: 0;
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

/* The reservation, and nothing else: five lines held open whoever is speaking.
   Together with the reserved third response below it is what holds the exhibits
   at one height for the whole trial - a two-line witness followed by a six-line
   prosecutor moved the strip under the player mid-comparison, and comparing
   those photographs is the game. Nothing is cut: the rare statement that runs
   past five lines scrolls in here, which is the price of the strip standing
   still.

   It carries the type scale rather than the statement inside it, so the em
   height below is five lines of the size actually rendered. */
.examination__frame {
    font-family: var(--transcript);
    font-size: clamp(1.125rem, 0.95rem + 0.9vw, 1.5rem);
    line-height: 1.5;
    height: 7.5em;
    overflow-y: auto;
    /* The gutter is there whether that statement scrolls or not, so the line
       breaks do not move between one question and the next. */
    scrollbar-gutter: stable;
    margin: 0 0 2rem;
}

.examination__frame:focus {
    outline: none;
}

/* The voice the player is listening to gets the largest type on the page. Its
   own height is the height of the speech: the rule down the left marks what was
   said, and drawing it the full height of the frame would have it measuring
   blank paper the speaker never used. */
.examination__statement {
    margin: 0;
    padding-left: 1.1rem;
    border-left: 3px solid var(--stamp);
}

.examination__cue {
    font-family: var(--transcript);
    font-size: 0.75rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ink-soft);
    margin: 0 0 0.75rem;
}

/* Three slots, always, because the generator is told to write two or three
   choices (case_prompt.ts) and a node with two must not pull the exhibits up
   under it. The third row is empty paper when it is unused.

   13rem is three 4rem rows and the two gaps between them, against the 3.18rem a
   single-line response actually occupies: most are a sentence and wrap to two
   lines on a narrower page, so a reservation sized to the shortest possible
   response runs out exactly when it is needed. Held as one min-height rather
   than three tall rows, with align-content start, so the options stay tight
   together at the top and the slack collects underneath as blank paper - the
   same shape as the statement frame above. Longer responses, or a fourth choice
   the validator permits, grow the list past it. */
.responses {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    align-content: start;
    min-height: 13rem;
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

.rail {
    border-left: var(--rule);
    padding-left: clamp(1rem, 2vw, 1.5rem);
    /* The narrow column, so everything in it is set smaller than the same
       material is on the arrest sheet. CaseTimeline inherits this. */
    font-size: 0.8125rem;
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

/* With the witnesses moved into the drawer the timeline is all the rail holds,
   so the rule that separated the two records would double up on the rail's own. */
.rail__title--second:first-child {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
}

/* One statement, filed. The plate is what separates two witnesses at a glance,
   which a bold first line was not doing. */
.witness {
    background: var(--paper-shade);
    border: 1px solid var(--paper-edge);
    margin: 0 0 0.6rem;
}

.witness__name {
    margin: 0;
    padding: 0.3rem 0.5rem;
    background: var(--ink);
    color: var(--paper);
    font-family: var(--display);
    font-size: 0.6875rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    /* Long names wrap inside the plate rather than widening the rail. */
    overflow-wrap: anywhere;
}

.witness__claim {
    margin: 0;
    padding: 0.5rem;
    font-family: var(--transcript);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--ink-soft);
}

/* The clerk's line when something is entered mid-trial. The height is held
   whether it says anything or not: it sits directly above the exhibits on the
   wide layout and above the drawer bar on the narrow one, and neither may move
   under a player reaching for an answer. */
.entered {
    min-height: 1.4rem;
    margin: 0.75rem 0 0;
    font-family: var(--transcript);
    font-size: 0.8125rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--stamp);
    opacity: 0;
    transition: opacity 500ms ease;
}

.entered--on {
    opacity: 1;
    animation: entered-in 260ms ease-out;
}

/* Stamped on rather than faded in, so it is caught out of the corner of an eye
   that is reading the responses above it. */
@keyframes entered-in {
    from {
        opacity: 0;
        transform: translateY(-4px);
    }
}

/* Nothing on two columns, where both sections are already on the page. Shown by
   the one-column block at the bottom of this sheet. */
.drawers {
    display: none;
}

.drawers__tab {
    flex: 1;
    padding: 0.85rem 0.5rem;
    background: var(--paper-shade);
    color: var(--ink);
    border: none;
    font-family: var(--display);
    font-size: 0.75rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    transition:
        background 140ms ease,
        color 140ms ease;
}

/* The drawer that is out. Same inverted plate a witness name gets. */
.drawers__tab[aria-expanded="true"] {
    background: var(--ink);
    color: var(--paper);
}

/* Something has been filed in there that the player has not opened the drawer
   on. The pulse runs twice and stops; the dot stays until they look. Under
   reduced motion the global rule cuts the pulse and the dot carries it alone. */
.drawers__tab--fresh {
    animation: tab-pulse 900ms ease-out 2;
}

.drawers__tab--fresh::after {
    content: "";
    display: inline-block;
    width: 0.45rem;
    height: 0.45rem;
    margin-left: 0.4rem;
    vertical-align: 0.08em;
    border-radius: 50%;
    background: var(--stamp);
}

@keyframes tab-pulse {
    50% {
        background: var(--stamp);
        color: var(--paper);
    }
}

/* Nothing filed under it yet - the trial enters exhibits as it goes. */
.drawers__tab:disabled {
    color: var(--ink-soft);
    opacity: 0.55;
    cursor: default;
}

/* The drawer itself: pinned to the bottom edge, never taller than most of the
   screen, and scrolling inside rather than moving the courtroom behind it. */
.sheet {
    position: fixed;
    inset: auto 0 0;
    width: 100%;
    max-width: 100%;
    max-height: 82vh;
    margin: 0;
    padding: 0;
    /* On the dialog, not on the panel inside it: the panel is what scrolls past,
       so a rule drawn there slid up off the top edge on the first swipe. */
    border: none;
    border-top: 6px solid var(--ink);
    background: none;
    overflow-y: auto;
    /* The bar the tabs sit on is drawn under the backdrop, so the sheet has to
       clear the home indicator itself. */
    padding-bottom: env(safe-area-inset-bottom);
    overscroll-behavior: contain;
    animation: sheet-in 220ms ease-out;
}

/* Slides up out of the bar that opened it. The global reduced-motion rule cuts
   the duration to nothing, so this stays a straight appearance for anyone who
   asked for less movement. */
@keyframes sheet-in {
    from {
        transform: translateY(100%);
    }
}

.sheet::backdrop {
    background: rgb(20 24 33 / 62%);
}

.sheet__panel {
    background: var(--paper-shade);
    padding: 0 var(--step) var(--step);
}

/* Held at the top of the drawer while its contents scroll: this is the only
   copy of the tabs reachable while the sheet is up, since the bar along the
   bottom of the courtroom is behind the backdrop. */
.sheet__bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    margin: 0 calc(var(--step) * -1);
    padding: 0 0.5rem;
    background: var(--paper-shade);
    border-bottom: var(--rule);
    /* So the exhibits read as passing underneath it rather than through it. */
    box-shadow: 0 6px 10px rgb(23 28 38 / 10%);
}

.sheet__close {
    flex: none;
    padding: 0 0.75rem;
    background: none;
    border: none;
    color: var(--ink-soft);
    font-family: var(--transcript);
    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
}

.sheet__close:hover {
    color: var(--ink);
}

/* The evidence section brings its own rule and heading with it, and inside the
   drawer the rule sits directly under the sticky bar's. */
.sheet__body > .evidence {
    border-top: none;
}

/* The tab that pulled the drawer open already names what is in it, so the
   heading is repeating the word directly above it. Taken out of the picture but
   left in the accessibility tree: it is what gives the drawer its structure for
   anyone who cannot see which tab is lit. */
/* The exhibits arrive with their section's own padding; the witness cards have
   none of their own, and with the heading clipped they started against the bar. */
#sheet-witnesses {
    padding-top: 1.25rem;
}

.sheet__body .evidence__title,
.sheet__body .rail__title {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}

/* In the drawer the photographs run full width, one under the other, rather
   than along a bench: a sideways strip on a phone hides the third exhibit
   behind a gesture nothing announces, and a clock face is worth the width. */
.sheet__body .evidence__strip {
    flex-direction: column;
    align-items: stretch;
    overflow-x: visible;
}

.sheet__body .exhibit {
    flex: 0 0 auto;
}

.evidence {
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

/* Exhibits are photographs taped into the file, so they sit slightly askew.
   11.5rem, not the 13.5rem this was when the strip ran the full width of the
   sheet: the column it sits in now is the narrower one, and three tiles have to
   fit it side by side without scrolling. The lightbox is still where a clock
   face gets read. */
.exhibit {
    position: relative;
    flex: 0 0 11.5rem;
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

/* Opacity only. Animating the tile in from rotate(-4deg) translateY(10px) swung
   its corners outside the strip for the length of the animation - the strip is
   an overflow container, so both scrollbars appeared for that moment and then
   went away again as the tile settled. A fade cannot overflow anything. */
@keyframes exhibit-in {
    from {
        opacity: 0;
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

    /* Out of the flow along the bottom edge, so the drawers are in reach at
       whatever point of the transcript the player has scrolled to. */
    .drawers {
        display: flex;
        position: fixed;
        inset: auto 0 0;
        z-index: 5;
        gap: 1px;
        background: var(--paper-edge);
        border-top: 2px solid var(--ink);
        padding-bottom: env(safe-area-inset-bottom);
        box-shadow: 0 -6px 18px rgb(23 28 38 / 18%);
    }

    /* The room the bar takes, which it cannot claim itself. */
    .court {
        padding-bottom: calc(4.5rem + env(safe-area-inset-bottom));
    }

    .rail {
        border-left: none;
        border-top: var(--rule);
        padding-left: 0;
        padding-top: 1.5rem;
    }

    /* Six and a half lines held, and a floor rather than a ceiling. The
       reservation exists to hold the exhibit strip still, and on one column the
       strip is off-screen while the statement is being read - so a long
       statement moving the page is a cheaper price than reading it through a
       scrollbox inside a scrolling page. */
    .examination__frame {
        height: auto;
        min-height: 9.75em;
        overflow-y: visible;
    }
}
</style>
