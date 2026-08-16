<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
    PublicCase,
    PublicCaseSummary,
    PublicEvidence,
    PublicTrialNode,
    Truth,
    Verdict,
} from "@paw-order/shared";
import {
    ApiError,
    createCase,
    fetchCase,
    fetchCaseBySlug,
    fetchPublicCases,
    playTurn,
} from "@/api";
import { forgetCase, playedCases, rememberCase } from "@/history";
import ArrestScreen from "@/screens/ArrestScreen.vue";
import CourtroomScreen from "@/screens/CourtroomScreen.vue";
import PreparingScreen from "@/screens/PreparingScreen.vue";
import UploadScreen from "@/screens/UploadScreen.vue";
import VerdictScreen from "@/screens/VerdictScreen.vue";

const POLL_INTERVAL_MS = 2000;
// 3 minutes. Past this the generation is almost certainly a lost background job
// (see the ponytail note in case_service.ts) rather than a slow one.
const POLL_ATTEMPTS = 90;
// A poll runs ~90 times over 3 minutes across the public internet, so a 502 from
// the edge or a moment offline is expected, not exceptional. Giving up on the
// first one throws away a case that is generating perfectly well.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
/**
 * Both ways the wait can end with no case: the api reported FAILED, or the
 * generation never came back inside POLL_ATTEMPTS. The player is told the same
 * thing either way - from where they sit the two are one outcome.
 *
 * It does not say why, because the api does not know either by the time this is
 * read: a model that answered nothing usable and a model that refused the call
 * for the day both land here as FAILED. So it names both ways out rather than
 * only the retry - the old copy sent a player back to the file picker even when
 * a second photo could not possibly have worked. "Take another case" is the
 * button underneath, which goes back to the strips of cases already on file.
 */
const NO_CASE_MESSAGE =
    "No case could be filed for this photo. Try another photo, or take one of the cases already on file.";

const currentCase = ref<PublicCase | null>(null);
const error = ref<string | null>(null);
const preparing = ref(false);
/**
 * Set when the wait ended without a case: the generation failed, or it never
 * came back inside POLL_ATTEMPTS. The message stays on the preparing screen
 * rather than dropping the player back at the envelope, because they have been
 * watching that panel for three minutes and it is the panel that owes them an
 * answer. Errors thrown before generation starts - a refused upload, a rate
 * limit - still belong on the upload screen, where the retry is.
 */
const stalled = ref<string | null>(null);
/**
 * The photo and name of an attempt the api refused, handed back to the upload
 * screen. That screen is unmounted while a case generates, so without this a
 * rejected upload - the commonest failure, and the one most worth retrying -
 * costs the player their typed name and another trip through the file picker.
 */
const retry = ref<{ file: File; name: string; isPublic: boolean } | null>(null);

/**
 * The run. `path` is the whole list of choice indexes taken so far: the api
 * holds the effects table and replays it every turn, so there is no local score
 * to keep and nothing here to tamper with. `node` is whichever node that replay
 * left the player on, and `outcome` is set once the trial ends.
 */
const path = ref<number[]>([]);
const node = ref<PublicTrialNode | null>(null);
// Exhibits the api has unlocked so far. The case no longer arrives with the
// whole set, so this IS the exhibit list, not a list of ids into one.
const exhibits = ref<PublicEvidence[]>([]);
const outcome = ref<{ verdict: Verdict; score: number; truth: Truth } | null>(null);
// One turn in flight at a time: two clicks would otherwise push two indexes and
// send a path the player never chose.
const turning = ref(false);
// The arrest screen is a beat, not a state the api knows about: a ready case
// waits here until the player enters court.
const entered = ref(false);
// The "Your cases" strip, held here rather than read by the upload screen, so
// that dropping a dead case updates the list without remounting the screen and
// wiping whatever the player had typed into the defendant name field.
const previous = ref(playedCases());
// The id of the case being fetched by a tile click, or null. Drives the strip's
// own status line; a replay is usually fast, but on a cold cache it is a network
// round trip with nothing else on screen to say so.
const opening = ref<string | null>(null);
/**
 * The public docket, held here for the same reason `previous` is: a case that
 * turns out to be gone has to leave whichever strip it is in, and remounting
 * the upload screen to re-read a list would wipe the typed defendant name.
 */
const others = ref<PublicCaseSummary[]>([]);
/**
 * Their own cases have a strip of their own directly above, so a case that is
 * in both lists is shown once, in theirs. Playing a public case remembers it,
 * which is exactly when the two lists overlap.
 */
const otherCases = computed(() => {
    const mine = new Set(previous.value.map((played) => played.id));
    return others.value.filter((entry) => !mine.has(entry.id));
});

/**
 * The address bar is the app's only route: /case/<slug> for a case that can be
 * shared, / for everything else. No router - one path, matched here.
 *
 * Bounded and lowercase to match what the api will accept, so a hand-typed path
 * is turned away before it costs a request.
 */
const CASE_PATH = /^\/case\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
/** The api's own cap, so an overlong path is turned away before it costs a request. */
const MAX_SLUG_LENGTH = 64;

function slugFromLocation(): string | null {
    const slug = CASE_PATH.exec(window.location.pathname)?.[1];
    return slug !== undefined && slug.length <= MAX_SLUG_LENGTH ? slug : null;
}

/**
 * Puts the case in the address bar, so the link can be copied from there as
 * well as from the button.
 *
 * The equality check does two jobs: it keeps a reload or a repeated open from
 * stacking identical history entries, and it makes this safe to call from the
 * popstate handler's path, where the location is already what it should be and
 * pushing would fight the back button.
 */
function showUrl(slug: string | null, replace = false): void {
    const path = slug === null ? "/" : `/case/${slug}`;
    if (window.location.pathname === path) {
        return;
    }
    // replace, for a url that led nowhere: pushing "/" on top of a dead link
    // leaves the dead link one Back press away, where it fetches, fails and
    // pushes "/" again - a fixed point the Back button cannot get out of.
    if (replace) {
        window.history.replaceState({}, "", path);
        return;
    }
    window.history.pushState({}, "", path);
}

/** Back and forward move between a case and the home screen, the whole history here. */
function onPopState(): void {
    void openFromLocation();
}

onMounted(() => {
    window.addEventListener("popstate", onPopState);
    void loadDocket();
    void openFromLocation();
});

// The root component never unmounts in the built app, so this is for the dev
// server: without it every hot update leaves another listener behind, each
// answering one Back press against a detached instance.
onBeforeUnmount(() => {
    window.removeEventListener("popstate", onPopState);
});

/**
 * Opens whatever the address bar names. Runs on load - this is how a shared
 * link works at all - and on every back or forward.
 *
 * Not remembered in "Your cases": a case reached by someone else's link is not
 * one this browser made.
 */
async function openFromLocation(): Promise<void> {
    const slug = slugFromLocation();
    if (currentCase.value?.slug === slug && slug !== null) {
        return;
    }

    // Bumped before the home branch too, not only before a fetch: a link fetch
    // still in flight when the player presses Back would otherwise land after
    // the navigation, open its case and push the url straight back on.
    run += 1;
    const thisRun = run;
    // Whatever this navigation turns out to be, the generation that was being
    // polled is no longer the one on screen - the bumped run has already ended
    // its poll loop. Left set, `preparing` holds up a screen whose only way out
    // is the button that appears when a poll stalls, and no poll is running to
    // stall: a Back press mid-generation was a dead end short of a reload.
    preparing.value = false;
    stalled.value = null;

    if (slug === null) {
        // Navigated back out of a case. The url says home, so the app follows.
        if (currentCase.value) {
            takeAnotherCase();
        }
        return;
    }
    error.value = null;

    try {
        const result = await fetchCaseBySlug(slug);
        if (thisRun !== run) {
            return;
        }
        if (result.status !== "READY") {
            dropLink();
            return;
        }
        openCase(result);
    } catch (cause) {
        if (thisRun !== run) {
            return;
        }
        // A 404 is the case being gone, unpublished, or the link being wrong -
        // one message covers all three, because from here they are one thing.
        if (cause instanceof ApiError && cause.status === 404) {
            dropLink();
            return;
        }
        error.value = cause instanceof ApiError ? cause.message : "That case would not open.";
    }
}

/** A link that leads nowhere: back to the envelope, and out of the address bar. */
function dropLink(): void {
    showUrl(null, true);
    error.value = "That case is no longer on file.";
}

/**
 * Fetched once, on load. A failure is silent: the docket is a strip of other
 * people's cases at the bottom of the home page, and a player who came here to
 * upload a photo is owed nothing about it.
 */
async function loadDocket(): Promise<void> {
    try {
        others.value = await fetchPublicCases();
    } catch {
        // Nothing to do and nothing to tell the player.
    }
}

/**
 * The one place a READY case becomes the case being played.
 *
 * `mine` is true only for a case this browser just generated. "Your cases" is
 * the list of dogs the player brought to court, not the list of cases they have
 * opened: one reached from the public docket belongs to whoever uploaded that
 * dog, and filing it under theirs claims someone else's. A replay is not
 * remembered either - a case can only be replayed from a strip it is already in.
 */
function openCase(ready: PublicCase, mine = false): void {
    currentCase.value = ready;
    entered.value = false;
    preparing.value = false;
    // The attempt landed, so there is nothing left to retry - and holding the
    // File would pin the whole photo in memory for the length of the trial.
    retry.value = null;
    // A shareable case puts its link in the address bar and keeps it there for
    // the whole trial, so it can be copied from there rather than only from the
    // button. A private one has no link to show.
    showUrl(ready.slug);
    if (!mine) {
        return;
    }
    rememberCase({
        id: ready.id,
        name: ready.defendant.name,
        title: ready.crime.title,
        charge: ready.crime.charge,
        photoUrl: ready.defendant.photoUrl,
    });
    previous.value = playedCases();
}

/**
 * Replays a case the player already paid a generation for. No poll: the case is
 * READY or it is gone, and a gone case is dropped from the strip rather than
 * left there to fail again on the next click.
 */
async function onReplay(id: string): Promise<void> {
    run += 1;
    const thisRun = run;
    error.value = null;
    // Normally a cache revalidation and over in a moment, which is why this is a
    // line on the strip rather than the whole preparing screen - that one talks
    // about generation, which is not what is happening.
    opening.value = id;

    try {
        const result = await fetchCase(id, true);
        if (thisRun !== run) {
            return;
        }
        if (result.status !== "READY") {
            dropCase(id);
            return;
        }
        openCase(result);
    } catch (cause) {
        if (thisRun !== run) {
            return;
        }
        // A 404 means the case is gone for good; anything else may be the
        // network, so only the miss drops the tile.
        if (cause instanceof ApiError && cause.status === 404) {
            dropCase(id);
            return;
        }
        // Only the api's own copy is worth showing. Anything else here is a
        // transport failure, whose message is "Failed to fetch" or a JSON parse
        // error against a proxy's HTML - neither of which is for a player.
        error.value = cause instanceof ApiError ? cause.message : "That case would not open.";
    } finally {
        // Unconditional, superseded runs included: the strip must never be left
        // showing a case as opening after a new one has taken over.
        opening.value = null;
    }
}

/** A case the api will not serve again: off the strip, and say so once. */
function dropCase(id: string): void {
    forgetCase(id);
    previous.value = playedCases();
    // Both strips: a public case can be gone too, and the docket is only
    // fetched on load, so without this the dead tile sits there until reload.
    others.value = others.value.filter((entry) => entry.id !== id);
    error.value = "That case is no longer on file.";
}

/** gamedesign.md 14: one screen at a time, in order. */
const screen = computed(() => {
    if (preparing.value) {
        return "preparing";
    }
    if (!currentCase.value) {
        return "upload";
    }
    if (!entered.value) {
        return "arrest";
    }
    return outcome.value ? "verdict" : "courtroom";
});

/**
 * Every screen is a new page of the file, and the browser keeps the scroll of
 * the one before it: a case opened from the bottom of the strip - which is where
 * the strip is on a phone - arrived on the arrest sheet already scrolled past
 * its own heading. Here rather than in each screen's onMounted, so it holds for
 * every move between them, including Back.
 */
watch(screen, () => window.scrollTo({ top: 0 }), { flush: "post" });

function startTrial(): void {
    path.value = [];
    node.value = currentCase.value?.rootNode ?? null;
    exhibits.value = currentCase.value?.evidence ?? [];
    outcome.value = null;
    // Both of these were missed the first time. A hung turn left `turning` true
    // forever, so a freshly generated case rendered with every choice disabled
    // and no way back; and a failed turn's alert survived into the next run.
    turning.value = false;
    error.value = null;
}

function enterCourt(): void {
    startTrial();
    entered.value = true;
}

/** Back to the envelope. The api holds no run state, so nothing to tear down. */
function takeAnotherCase(): void {
    showUrl(null);
    run += 1;
    currentCase.value = null;
    entered.value = false;
    outcome.value = null;
    node.value = null;
    exhibits.value = [];
    error.value = null;
    preparing.value = false;
    stalled.value = null;
    retry.value = null;
}

async function choose(index: number): Promise<void> {
    const id = currentCase.value?.id;
    if (!id || turning.value) {
        return;
    }
    // Same guard the poll loop uses: uploading a new photo mid-turn bumps `run`,
    // and without this the in-flight turn resolves afterwards and writes the
    // previous case's trial over the new one.
    const thisRun = run;
    turning.value = true;
    error.value = null;
    // Not pushed onto path until the api accepts it, so a rejected turn leaves
    // the run where it was instead of desynchronised from the server.
    const attempted = [...path.value, index];
    try {
        const turn = await playTurn(id, attempted);
        if (thisRun !== run) {
            return;
        }
        path.value = attempted;
        exhibits.value = turn.evidence;
        if (turn.status === "VERDICT") {
            node.value = null;
            outcome.value = { verdict: turn.verdict, score: turn.score, truth: turn.truth };
        } else {
            node.value = turn.node;
        }
    } catch (cause) {
        if (thisRun !== run) {
            return;
        }
        error.value = cause instanceof Error ? cause.message : "That move did not land.";
    } finally {
        // Unconditional: a superseded turn must still release the buttons, or
        // the new case starts with every choice disabled.
        turning.value = false;
    }
}

// Bumped on every upload so an in-flight poll from a previous photo stops
// instead of overwriting the new case.
let run = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// honeypot is the upload screen's hidden field, passed through rather than
// stored: `retry` replays a real player's attempt, and a real player's is empty.
async function onPhoto(
    file: File,
    name: string,
    isPublic: boolean,
    honeypot: string,
): Promise<void> {
    run += 1;
    const thisRun = run;
    preparing.value = true;
    error.value = null;
    stalled.value = null;
    retry.value = { file, name, isPublic };
    currentCase.value = null;
    entered.value = false;

    try {
        const accepted = await createCase(file, name, isPublic, honeypot);
        let consecutiveFailures = 0;

        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
            await sleep(POLL_INTERVAL_MS);
            if (thisRun !== run) {
                return;
            }

            // A failed poll is a failed poll, not a failed case: swallow it and
            // ask again. Only a run of them means the api is actually gone.
            let result;
            try {
                result = await fetchCase(accepted.id);
            } catch (pollError) {
                consecutiveFailures += 1;
                if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                    throw pollError;
                }
                continue;
            }
            consecutiveFailures = 0;

            if (result.status === "READY") {
                // The one call that owns the case: this browser paid for it.
                openCase(result, true);
                return;
            }
            if (result.status === "FAILED") {
                stalled.value = NO_CASE_MESSAGE;
                return;
            }
        }
        stalled.value = NO_CASE_MESSAGE;
    } catch (cause) {
        if (thisRun !== run) {
            return;
        }
        error.value = cause instanceof Error ? cause.message : "Upload failed.";
        preparing.value = false;
    }
}
</script>

<template>
    <UploadScreen
        v-if="screen === 'upload'"
        :error="error"
        :previous="previous"
        :others="otherCases"
        :opening="opening"
        :retry="retry"
        @photo="onPhoto"
        @replay="onReplay"
    />

    <PreparingScreen
        v-else-if="screen === 'preparing'"
        :stalled="stalled"
        @leave="takeAnotherCase"
    />

    <ArrestScreen
        v-else-if="screen === 'arrest' && currentCase"
        :current-case="currentCase"
        @enter="enterCourt"
        @leave="takeAnotherCase"
    />

    <CourtroomScreen
        v-else-if="screen === 'courtroom' && currentCase && node"
        :node="node"
        :exhibits="exhibits"
        :witnesses="currentCase.witnesses"
        :charge="currentCase.crime.charge"
        :timeline="currentCase.crime.timeline"
        :defendant-name="currentCase.defendant.name"
        :question="path.length + 1"
        :turning="turning"
        :error="error"
        @choose="choose"
        @abandon="takeAnotherCase"
    />

    <VerdictScreen
        v-else-if="screen === 'verdict' && currentCase && outcome"
        :verdict="outcome.verdict"
        :score="outcome.score"
        :truth="outcome.truth"
        :exhibits="exhibits"
        :defendant-name="currentCase.defendant.name"
        :slug="currentCase.slug"
        @again="enterCourt"
        @new-case="takeAnotherCase"
    />
</template>
