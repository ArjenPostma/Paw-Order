import { describe, expect, it } from "vitest";
import { saysDog } from "@/cases_bundle/services/case_generator";

/**
 * The dog check's answer is a model response, so it is narrowed rather than
 * read. looksLikeDog itself short-circuits under APP_ENV=test and never reaches
 * the model, which leaves this narrowing as the only part of the gate a test
 * can actually execute - and the part where a rewrite would silently start
 * accepting a string, a number or a missing field as "yes".
 */
describe("saysDog", () => {
    it("accepts only the boolean true", () => {
        expect(saysDog({ isDog: true })).toBe(true);
        expect(saysDog({ isDog: false })).toBe(false);
    });

    it("refuses a truthy value that is not the boolean", () => {
        // A model that answers with the STRING "false" would otherwise pass:
        // every non-empty string is truthy.
        expect(saysDog({ isDog: "false" })).toBe(false);
        expect(saysDog({ isDog: "true" })).toBe(false);
        expect(saysDog({ isDog: 1 })).toBe(false);
    });

    it("refuses anything that is not the expected shape", () => {
        // parseJson answers null for a non-JSON body; looksLikeDog treats that
        // as a non-answer and falls open before this is ever asked, but the
        // narrowing must not read it as a yes either.
        expect(saysDog(null)).toBe(false);
        expect(saysDog(undefined)).toBe(false);
        expect(saysDog({})).toBe(false);
        expect(saysDog([])).toBe(false);
        expect(saysDog("isDog")).toBe(false);
        expect(saysDog(true)).toBe(false);
    });
});
