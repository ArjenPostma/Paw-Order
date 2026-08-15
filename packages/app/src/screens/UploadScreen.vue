<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { PlayedCase } from "@/history";
import { downscale } from "@/image";

// `previous` is a prop, not a localStorage read of this screen's own: dropping a
// dead case has to update the strip, and remounting this component to re-read it
// would throw away whatever the player had typed into the name field.
defineProps<{ error: string | null; previous: PlayedCase[]; opening: string | null }>();
const emit = defineEmits<{ photo: [file: File, name: string]; replay: [id: string] }>();

// Matches MAX_NAME_LENGTH in the api's router, which cuts it again anyway.
const MAX_NAME_LENGTH = 32;

const name = ref("");

// Mirrors what the api accepts. The api re-checks both and stays the authority;
// this exists because a rejected upload still costs the caller their one
// generation per minute, so the round trip is worth not making.
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 8 * 1024 * 1024;

// Drag state is local: nothing above this screen cares that a file is hovering.
const dragging = ref(false);
const rejected = ref<string | null>(null);

/**
 * The chosen photo, waiting on the player to confirm it. Held here rather than
 * sent straight up: a generation is one of a very small daily allowance and a
 * minute of waiting, and the wrong photo dropped by accident used to spend both
 * before the player saw what they had picked.
 */
const pending = ref<{ file: File; url: string } | null>(null);

/**
 * The one filter both entry points share. `accept="image/*"` constrains the
 * picker's default view and nothing else - a drop bypasses it entirely, and the
 * picker itself lets a determined user switch to "All Files" - so neither path
 * can be trusted to have filtered anything.
 */
function take(file: File | undefined): void {
    if (!file) {
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
    if (!held) {
        return;
    }
    // Resized here rather than at pick time: the checks in take() are against
    // the api's own limits, and what the api sees is only ever smaller.
    emit("photo", await downscale(held.file), name.value.trim());
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
            <img v-if="pending" class="envelope__preview" :src="pending.url" alt="" />
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

        <!-- Outside the label, like the name field and for the same reason: a
             button inside it would open the file picker instead of booking. -->
        <button v-if="pending" class="book" type="button" @click="book">Enter court</button>

        <p v-if="rejected || error" class="upload__error" role="alert">
            {{ rejected ?? error }}
        </p>

        <!-- Replaying costs no generation, so the way back to a case already
             paid for belongs on the same screen as the way to a new one. -->
        <section v-if="previous.length > 0" class="prior">
            <h2 class="field-label">Cases on file</h2>

            <!-- Always mounted, so it can announce: a live region only speaks
                 when it was already in the accessibility tree before its text
                 changed. Usually blank, because a replay is usually a cache
                 revalidation and over before it is read. -->
            <p class="prior__status" aria-live="polite">
                {{ opening ? "Pulling the file" : "" }}
            </p>

            <ul class="prior__strip">
                <li v-for="played in previous" :key="played.id">
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
                        <img
                            v-if="played.photoUrl"
                            class="prior__photo"
                            :src="played.photoUrl"
                            alt=""
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

.book:hover {
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

/* Square, matching what the generator now renders. The uploaded photo is not
   resized anywhere yet, so this crops a full-size original into a 6rem tile. */
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

@media (max-height: 40rem) {
    .upload__docket {
        position: static;
        transform: none;
    }
}
</style>
