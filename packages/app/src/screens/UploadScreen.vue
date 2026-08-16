<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { PublicCaseSummary } from "@paw-order/shared";
import type { PlayedCase } from "@/history";
import { downscale } from "@/image";

// `previous` is a prop, not a localStorage read of this screen's own: dropping a
// dead case has to update the strip, and remounting this component to re-read it
// would throw away whatever the player had typed into the name field.
// `retry` is the photo and name of an attempt the api refused, handed back so a
// rejected upload does not cost the player their typed name and their file
// picker trip - this screen is unmounted while the case is generating, so its
// own state does not survive the round trip.
const props = defineProps<{
    error: string | null;
    previous: PlayedCase[];
    others: PublicCaseSummary[];
    opening: string | null;
    retry: { file: File; name: string; isPublic: boolean } | null;
}>();
const emit = defineEmits<{
    photo: [file: File, name: string, isPublic: boolean, honeypot: string];
    replay: [id: string];
}>();

// Matches MAX_NAME_LENGTH in the api's router, which cuts it again anyway.
const MAX_NAME_LENGTH = 32;

const name = ref(props.retry?.name ?? "");
/**
 * Whether this case goes into the public record. Private unless the player says
 * otherwise, and fixed at upload: the api has no route that changes it later,
 * so the box is the only moment this is decided.
 */
const publicRecord = ref(props.retry?.isPublic ?? false);

/**
 * The two case strips along the bottom, their own always first. One tile
 * renders both: a docket entry carries exactly the fields a stored case does.
 * Empty strips are dropped here rather than with a v-if on the section, which
 * cannot see the loop variable.
 */
const strips = computed(() =>
    [
        { key: "mine", heading: "Your cases", cases: props.previous },
        { key: "public", heading: "Other cases", cases: props.others },
    ].filter((strip) => strip.cases.length > 0),
);

// Mirrors what the api accepts. The api re-checks both and stays the authority;
// this exists because a rejected upload still costs the caller their one
// generation per minute, so the round trip is worth not making.
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The honeypot. Off-screen rather than display:none or type="hidden", because a
 * form filler skips both of those and fills this one; hidden from assistive tech
 * so nobody is ever offered a field the api will refuse them for. Whatever ends
 * up here goes to the api as-is - the check that matters is the api's.
 */
const website = ref("");

// Drag state is local: nothing above this screen cares that a file is hovering.
const dragging = ref(false);
const rejected = ref<string | null>(null);

/**
 * The chosen photo, waiting on the player to confirm it. Held here rather than
 * sent straight up: a generation is one of a very small daily allowance and a
 * minute of waiting, and the wrong photo dropped by accident used to spend both
 * before the player saw what they had picked.
 */
const pending = ref<{ file: File; url: string } | null>(
    props.retry ? { file: props.retry.file, url: URL.createObjectURL(props.retry.file) } : null,
);

/**
 * True from the confirm until the parent takes over the screen. The confirm
 * awaits the resize, which is hundreds of milliseconds on a phone photo with the
 * button still live, and a second click there sends a second upload: the api's
 * dedupe does not catch it (its read and its insert are not atomic), so one
 * request wins the per-minute slot and generates a case the client is no longer
 * listening to, while the other is refused - a whole generation, out of two a
 * day, spent on a case the player never sees.
 */
const booking = ref(false);

/**
 * The one filter both entry points share. `accept="image/*"` constrains the
 * picker's default view and nothing else - a drop bypasses it entirely, and the
 * picker itself lets a determined user switch to "All Files" - so neither path
 * can be trusted to have filtered anything.
 */
function take(file: File | undefined): void {
    // Refused while a confirm is in flight: book() captured the held photo
    // before awaiting the resize, so a swap here would send the old file while
    // the preview showed the new one.
    if (!file || booking.value) {
        return;
    }
    if (!ACCEPTED_TYPES.includes(file.type)) {
        rejected.value = "That is not a photo. Use a JPG, PNG or WebP.";
        return;
    }
    if (file.size > MAX_BYTES) {
        rejected.value = "That photo is over 8MB. Try a smaller one.";
        return;
    }
    rejected.value = null;
    // The preview is of what was picked, not of what will be sent: the resize
    // waits for the confirm, so swapping photos costs no work.
    replacePending({ file, url: URL.createObjectURL(file) });
}

/** One place to swap the held photo, so its object URL is always revoked. */
function replacePending(next: { file: File; url: string } | null): void {
    if (pending.value) {
        URL.revokeObjectURL(pending.value.url);
    }
    pending.value = next;
}

onBeforeUnmount(() => {
    replacePending(null);
});

async function book(): Promise<void> {
    const held = pending.value;
    if (!held || booking.value) {
        return;
    }
    booking.value = true;
    // Resized here rather than at pick time: the checks in take() are against
    // the api's own limits, and what the api sees is only ever smaller.
    emit("photo", await downscale(held.file), name.value.trim(), publicRecord.value, website.value);
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

/**
 * dragleave fires on the zone every time the pointer crosses onto one of the
 * spans inside it, so an unguarded handler flickers the highlight off and back
 * on as the photo is dragged over the label's own text. Only a leave that lands
 * outside the zone entirely counts.
 */
function onDragLeave(event: DragEvent): void {
    const zone = event.currentTarget;
    const entering = event.relatedTarget;
    if (zone instanceof Node && entering instanceof Node && zone.contains(entering)) {
        return;
    }
    dragging.value = false;
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

        <!-- Outside the envelope's label on purpose: that label IS the file
             input, so a text field inside it opens the file picker on click. -->
        <label class="named">
            <span class="field-label">Defendant's name</span>
            <input
                v-model="name"
                class="named__input"
                type="text"
                placeholder="Who's the good boy?"
                :maxlength="MAX_NAME_LENGTH"
                autocomplete="off"
            />
        </label>

        <!-- The honeypot, kept next to the field it imitates so a filler that
             reads the form in order meets it. aria-hidden and tabindex=-1 keep
             it away from anyone reading or tabbing the page. -->
        <label class="trap" aria-hidden="true">
            <span>Website</span>
            <input v-model="website" type="text" tabindex="-1" autocomplete="off" />
        </label>

        <!-- The label IS the drop zone: one target for click, keyboard and
             drag, so there is no second control to keep in sync. -->
        <label
            class="envelope"
            :class="{ 'envelope--dragging': dragging }"
            @dragover.prevent="dragging = true"
            @dragleave="onDragLeave"
            @drop.prevent="onDrop"
        >
            <input class="envelope__input" type="file" accept="image/*" @change="onFileChange" />
            <span class="field-label">Exhibit A &middot; the defendant</span>
            <!-- The preview IS the picker: the zone keeps every one of its
                 targets, so a wrong photo is swapped by clicking or dropping
                 again, with no second control to reach for. -->
            <!-- Named, not alt="": the preview exists so the player can catch a
                 wrong photo before it costs a generation, and an empty alt puts
                 a screen-reader user back where they started. -->
            <img
                v-if="pending"
                class="envelope__preview"
                :src="pending.url"
                :alt="`Selected photo: ${pending.file.name}`"
            />
            <span class="envelope__action">
                {{ pending ? "Not this dog?" : "Choose a dog photo" }}
            </span>
            <span class="envelope__hint">
                {{
                    pending
                        ? "Click or drop another photo to swap"
                        : "or drop one here · JPG, PNG or WebP, up to 8MB"
                }}
            </span>
        </label>

        <!-- With the confirm, not with the name field: this is a decision about
             a case that does not exist yet, and it is fixed the moment the
             button below is pressed. Outside the envelope's label like every
             other control here - inside it, a click would open the picker. -->
        <label v-if="pending" class="record">
            <input v-model="publicRecord" class="record__box" type="checkbox" />
            <span class="record__text">
                <span class="record__label">Enter into the public record</span>
                <span class="record__hint">
                    Other visitors can open this case and defend your dog.
                </span>
            </span>
        </label>

        <!-- Outside the label, like the name field and for the same reason: a
             button inside it would open the file picker instead of booking. -->
        <button v-if="pending" class="book" type="button" :disabled="booking" @click="book">
            Enter court
        </button>

        <p v-if="rejected || error" class="upload__error" role="alert">
            {{ rejected ?? error }}
        </p>

        <!-- Replaying costs no generation, so the way back to a case already
             paid for belongs on the same screen as the way to a new one - and
             the same is true of a case someone else paid for. -->
        <section v-for="strip in strips" :key="strip.key" class="prior">
            <h2 class="field-label">{{ strip.heading }}</h2>

            <!-- Always mounted, so it can announce: a live region only speaks
                 when it was already in the accessibility tree before its text
                 changed. Usually blank, because a replay is usually a cache
                 revalidation and over before it is read. Only the strip holding
                 the case being opened says anything. -->
            <p class="prior__status" aria-live="polite">
                {{ strip.cases.some((entry) => entry.id === opening) ? "Pulling the file" : "" }}
            </p>

            <ul class="prior__strip">
                <li v-for="played in strip.cases" :key="played.id">
                    <!-- Not disabled while one is opening: a second click is
                         safe (App.vue's run counter supersedes the first fetch
                         rather than racing it), and disabling would drop the
                         tiles out of the accessibility tree mid-interaction. -->
                    <button
                        class="prior__case"
                        type="button"
                        :aria-busy="opening === played.id"
                        @click="$emit('replay', played.id)"
                    >
                        <!-- Absent when the api inlined the photo as a data URL:
                             see rememberCase. The placard stands in for it. -->
                        <!-- width/height so the strip reserves the square
                             before the image lands: these are the player's own
                             uploads at up to 1024px (and at the full 8MB when
                             downscale had to give up), painted into a 96px
                             tile. -->
                        <img
                            v-if="played.photoUrl"
                            class="prior__photo"
                            :src="played.photoUrl"
                            alt=""
                            width="96"
                            height="96"
                            loading="lazy"
                        />
                        <!-- Array.from, not slice: a name starting with an
                             astral character would otherwise lose half its
                             surrogate pair and render as a replacement glyph. -->
                        <span v-else class="prior__photo prior__photo--none" aria-hidden="true">
                            {{ Array.from(played.name)[0] }}
                        </span>
                        <span class="prior__name">{{ played.name }}</span>
                        <span class="prior__charge">{{ played.charge }}</span>
                    </button>
                </li>
            </ul>
        </section>
    </main>
</template>

<style scoped>
.upload {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: var(--step);
    text-align: center;
}

/* In the column, not pinned to the top of it. Absolutely positioned it took no
   space, so as soon as the page grew past the viewport - which the checkbox and
   the second case strip both do - the centred content slid up underneath it and
   the title printed over the line. */
.upload__docket {
    margin: 0 0 0.25rem;
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

/* A line on the docket cover above the envelope, not a form field on a page. */
.named {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    width: min(30rem, 100%);
    text-align: left;
}

.named__input {
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: var(--paper-shade);
    color: var(--ink);
    border: 1px solid var(--paper-edge);
    border-bottom: 2px solid var(--ink-soft);
    font-family: var(--transcript);
    font-size: 1rem;
}

/* The browser default is a flat grey that reads as a disabled field on manila. */
.named__input::placeholder {
    color: var(--ink-soft);
}

.named__input:focus-visible {
    outline: 3px solid var(--stamp);
    outline-offset: 2px;
}

/* Taken out of the page rather than hidden: display:none and visibility:hidden
   are both skipped by the form fillers this exists to catch. Sized to nothing
   and clipped so it cannot be scrolled to or land under a stray click. */
.trap {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
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

/* Square and cropped, the way the mugshot on the arrest sheet is: this is the
   first look at what the file will hold. */
.envelope__preview {
    width: 12rem;
    height: 12rem;
    object-fit: cover;
    border: var(--rule);
    background: var(--paper);
}

/* A line the player initials before the case is filed, set against the envelope
   above it rather than as a form row on a page. */
.record {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    width: min(30rem, 100%);
    padding: 0.6rem 0.75rem;
    background: var(--paper-shade);
    border: 1px solid var(--paper-edge);
    text-align: left;
    cursor: pointer;
}

/* Native, restyled only where it clashes: the platform checkbox already has the
   keyboard behaviour, the indeterminate-free semantics and the focus ring. */
.record__box {
    flex: none;
    width: 1.1rem;
    height: 1.1rem;
    margin-top: 0.1rem;
    accent-color: var(--stamp);
}

.record__text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
}

.record__label {
    font-family: var(--display);
    font-size: 0.9375rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
}

.record__hint {
    font-family: var(--transcript);
    font-size: 0.8125rem;
    color: var(--ink-soft);
}

/* The verdict screen's primary action, in the one other place a click costs a
   generation. */
.book {
    width: min(30rem, 100%);
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

.book:disabled {
    background: var(--ink-soft);
    border-color: var(--ink-soft);
}

.book:hover:not(:disabled) {
    background: var(--stamp);
    border-color: var(--stamp);
    transform: translateY(-2px);
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

/* Mugshots clipped to the file, along the bottom of the cover. Scrolls rather
   than wraps for the same reason the exhibit strip does. */
.prior {
    width: min(46rem, 100%);
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: var(--rule);
    text-align: left;
}

/* Height held whether or not it has text, so the strip does not jump when a
   case starts opening. */
.prior__status {
    min-height: 1.1rem;
    margin: 0.35rem 0 0;
    font-family: var(--transcript);
    font-size: 0.75rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ink-soft);
}

.prior__case[aria-busy="true"] {
    opacity: 0.55;
    cursor: progress;
}

.prior__strip {
    list-style: none;
    display: flex;
    gap: 0.75rem;
    margin: 0.5rem 0 0;
    /* overflow-x: auto clips vertically too, so the tile's hover lift would cut
       its own top border off against the scroll box. The padding is the room it
       lifts into. */
    padding: 0.25rem 0;
    overflow-x: auto;
}

.prior__case {
    display: grid;
    gap: 0.15rem;
    width: 7rem;
    padding: 0.35rem;
    background: var(--paper-shade);
    color: var(--ink);
    border: 1px solid var(--paper-edge);
    text-align: left;
    transition:
        border-color 140ms ease,
        transform 140ms ease;
}

.prior__case:hover {
    border-color: var(--stamp);
    transform: translateY(-2px);
}

/* Square, matching what the generator now renders: this crops the uploaded
   photo, capped at 1024px by downscale(), into a 6rem tile. */
.prior__photo {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    background: var(--paper-edge);
}

.prior__photo--none {
    display: grid;
    place-items: center;
    font-family: var(--display);
    font-size: 2rem;
    color: var(--ink-soft);
}

.prior__name {
    font-family: var(--display);
    font-size: 0.9375rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding-top: 0.2rem;
}

.prior__charge {
    font-family: var(--transcript);
    font-size: 0.75rem;
    line-height: 1.3;
    color: var(--ink-soft);
}
</style>
