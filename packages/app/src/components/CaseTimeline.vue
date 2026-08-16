<script setup lang="ts">
import { computed } from "vue";

/**
 * The prosecution's timeline, on the arrest sheet and again in the courtroom
 * rail. One component because the parse belongs in one place: the two screens
 * were rendering the same model prose as two different lists.
 *
 * Type size is inherited, not a prop - the sheet sets it larger than the rail
 * does, and that is the only difference between the two.
 */
const props = defineProps<{ entries: string[] }>();

/**
 * "14:00 - Cake placed on the counter" split into its two halves.
 *
 * The prompt asks for "HH:MM - what happened" and nothing validates it, so this
 * is deliberately forgiving: a dot for a colon, an am/pm suffix, any of the
 * three dashes or a colon as the separator. An entry that matches none of that
 * is not mangled into a shape it does not have - it renders as one line across
 * both columns, which is also what every case generated before this looked
 * like.
 */
const TIMED_ENTRY = /^\s*(\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?)\s*[-–—:]\s+(.+)$/i;

const marks = computed(() =>
    props.entries.map((entry) => {
        const match = TIMED_ENTRY.exec(entry);
        return match
            ? { time: match[1]?.trim() ?? null, event: match[2]?.trim() ?? entry.trim() }
            : { time: null, event: entry.trim() };
    }),
);
</script>

<template>
    <ol class="case-timeline">
        <!-- Keyed by position: the entries are model prose with no uniqueness
             constraint, and two identical lines would collide on a text key. -->
        <li v-for="(mark, index) in marks" :key="`t${index}`" class="case-timeline__mark">
            <span v-if="mark.time" class="case-timeline__time">{{ mark.time }}</span>
            <span
                class="case-timeline__event"
                :class="{ 'case-timeline__event--full': !mark.time }"
            >
                {{ mark.event }}
            </span>
        </li>
    </ol>
</template>

<style scoped>
/* Node, rail and gutter all come off --node, so the line cannot drift out of
   the centre of the dots when one of them is adjusted. --centre is the offset
   of the node's own centre line, which is where the rail has to sit.

   Whole pixels, not rem: at 0.7rem the node is 11.2px and the gutter 10.4px, so
   the circle and the 2px line snap to device pixels differently and the line
   lands half a pixel left of the dots it is supposed to run through. Every
   value here divides evenly instead. */
.case-timeline {
    --node: 12px;
    --rail: 2px;
    --gutter: 10px;
    --gap: 0.55rem;
    --centre: calc((var(--node) - var(--rail)) / 2);

    list-style: none;
    margin: 0;
    padding: 0 0 0 calc(var(--node) + var(--gutter));
    display: grid;
    gap: var(--gap);
    font-family: var(--transcript);
    font-size: inherit;
    line-height: 1.45;
}

.case-timeline__mark {
    position: relative;
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.6rem;
    align-items: baseline;
}

/* One segment per entry, from this node down to the next, rather than one line
   behind the whole list: drawn on the list it ran past the last node and out
   into the margin below the final entry. The last entry has nothing to reach,
   so it draws none. */
.case-timeline__mark::before {
    content: "";
    position: absolute;
    /* +1.5px is by eye, not by arithmetic: the calc alone puts the line dead
       centre of the node's box, and it still reads left of the dots. Half a
       pixel is a whole device pixel on a 2x screen, which is where it was
       judged. */
    left: calc(var(--centre) - var(--node) - var(--gutter) + 1.5px);
    top: 0.45em;
    bottom: calc(-1 * var(--gap));
    width: var(--rail);
    /* The paper edge, not the tape gold the nodes are drawn in: the line is
       what connects the marks, not one of them. */
    background: var(--paper-edge);
}

.case-timeline__mark:last-child::before {
    content: none;
}

/* The node, drawn after the segment so the line passes behind it rather than
   through it. */
.case-timeline__mark::after {
    content: "";
    position: absolute;
    left: calc(-1 * (var(--node) + var(--gutter)));
    top: 0.45em;
    width: var(--node);
    height: var(--node);
    transform: translateY(-50%);
    border: var(--rail) solid var(--tape);
    border-radius: 50%;
    background: var(--paper);
}

.case-timeline__time {
    font-weight: 700;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
}

.case-timeline__event {
    color: var(--ink-soft);
}

/* An entry the split did not recognise has no time to sit beside, so it takes
   the whole width rather than leaving an empty column. */
.case-timeline__event--full {
    grid-column: 1 / -1;
}
</style>
