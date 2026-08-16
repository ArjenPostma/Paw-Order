import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppDataSource } from "@/database_bundle/util/data_source";
import { CaseEntity } from "@/cases_bundle/models/case_entity";
import {
    GenerationBusyError,
    createCase,
    generationSlotsInUse,
    slugStem,
} from "@/cases_bundle/services/case_service";
import { generationDailyBudget } from "@/http/generation_budget";
import { deleteImage } from "@/storage/r2";

// The deadline is read once at module load, so lowering it has to happen before
// case_service is imported. vi.hoisted runs ahead of the imports above; 50ms is
// long enough that the row is inserted first and short enough to sit inside a
// normal test timeout.
vi.hoisted(() => {
    process.env.GENERATION_TIMEOUT_MS = "50";
});

/**
 * How the replacement generator below behaves. "hang" settles only on abort;
 * "failWithKeys" dies the way a tree stage does after the images are already
 * paid for, which is the only shape that carries keys to reclaim.
 */
const generation: { mode: "hang" | "failWithKeys"; storedKeys: string[] } = vi.hoisted(() => ({
    mode: "hang",
    storedKeys: [],
}));

// Only a generation that never returns can be timed out, and the fixture
// generator returns immediately - which is why no HTTP test could ever reach
// this path. The replacement settles ONLY on abort, so every assertion below is
// reachable exclusively through runGeneration's AbortController. Verified by
// mutation: drop controller.abort() and both tests fail on "case never left
// PENDING" rather than passing on some other path to FAILED.
vi.mock("@/cases_bundle/services/case_generator", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/cases_bundle/services/case_generator")>();
    return {
        ...actual,
        generateCaseBible: (
            _photoUrl: string,
            _photo: unknown,
            _defendantName: string,
            signal: AbortSignal,
        ) =>
            new Promise((_resolve, reject) => {
                if (generation.mode === "failWithKeys") {
                    reject(
                        new actual.GenerationFailure(
                            "tree",
                            generation.storedKeys,
                            new Error("tree stage refused"),
                        ),
                    );
                    return;
                }
                signal.addEventListener("abort", () => {
                    reject(new Error("hung generation aborted"));
                });
            }),
    };
});

// The bucket, so the reclaim below can be observed. uploadDogPhoto is real:
// under APP_ENV=test it answers a data URL and writes nothing, and it is what
// decodes the photo bytes.
vi.mock("@/storage/r2", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/storage/r2")>();
    return { ...actual, deleteImage: vi.fn(() => Promise.resolve()) };
});

// The daily budget is charged by the router before the 202 goes out, so nothing
// here charges it - what matters is whether a background failure hands the slot
// back, which only this seam can see.
vi.mock("@/http/generation_budget", () => ({
    generationDailyBudget: Object.assign(
        (_req: unknown, _res: unknown, next: () => void) => {
            next();
        },
        { release: vi.fn() },
    ),
}));

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

async function pollUntilSettled(id: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const entity = await AppDataSource.getRepository(CaseEntity).findOne({ where: { id } });
        if (entity && entity.status !== "PENDING") {
            return entity.status;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("case never left PENDING");
}

beforeAll(async () => {
    await AppDataSource.initialize();
});

afterAll(async () => {
    await AppDataSource.destroy();
});

afterEach(() => {
    generation.mode = "hang";
    generation.storedKeys = [];
    delete process.env.GENERATION_MAX_CONCURRENT;
    vi.mocked(deleteImage).mockClear();
    vi.mocked(generationDailyBudget.release).mockClear();
});

function uploadOne(): Promise<{ id: string; status: string }> {
    return createCase({ bytes: PNG_1X1, mimeType: "image/png" }, "Rex", null, false);
}

// The fixture has exactly one title, so nothing an HTTP test can upload reaches
// the cut or the fallback. Model titles are neither short nor reliably latin.
describe("slug stems", () => {
    it("keeps a title that fits, hyphenated and lowercase", () => {
        expect(slugStem("The Great Birthday Cake Heist")).toBe("the-great-birthday-cake-heist");
    });

    it("cuts a long title at a word rather than mid-word", () => {
        const stem = slugStem("The Extraordinarily Protracted Matter Of The Missing Sausage");
        expect(stem.length).toBeLessThanOrEqual(40);
        // The cut lands between words: no trailing hyphen, and no half word.
        // "of" ends exactly on the budget, and it is kept - looking one
        // character further is what makes the separator after it visible.
        expect(stem).toBe("the-extraordinarily-protracted-matter-of");
    });

    // One word past the budget has no earlier word to fall back to, so it is
    // cut where it is rather than reduced to nothing.
    it("cuts inside a single word too long to break", () => {
        expect(slugStem("z".repeat(50))).toBe("z".repeat(40));
    });

    it("folds accents rather than dropping the letters under them", () => {
        expect(slugStem("Café Caper")).toBe("cafe-caper");
    });

    // A title this keeps nothing of still has to produce a usable url: the six
    // hex that follow are what identify the row.
    it("falls back when a title survives as nothing", () => {
        expect(slugStem("...")).toBe("case");
        expect(slugStem("事件")).toBe("case");
        expect(slugStem("")).toBe("case");
    });
});

describe("generation deadline", () => {
    it("fails a case whose generation never returns", async () => {
        const accepted = await createCase(
            { bytes: PNG_1X1, mimeType: "image/png" },
            "Rex",
            null,
            false,
        );
        expect(accepted.status).toBe("PENDING");

        expect(await pollUntilSettled(accepted.id)).toBe("FAILED");
    });

    it("releases the generation slot when the deadline fires", async () => {
        const accepted = await createCase(
            { bytes: PNG_1X1, mimeType: "image/png" },
            "Rex",
            null,
            false,
        );
        await pollUntilSettled(accepted.id);

        // The release is in runGeneration's finally, which runs after the status
        // update the poll observed. A timeout that abandoned the slot would leak
        // a third of the api's concurrent capacity per hung call.
        for (let attempt = 0; attempt < 50 && generationSlotsInUse() > 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(generationSlotsInUse()).toBe(0);
    });
});

/**
 * The concurrency ceiling is the thing that bounds how many paid image calls are
 * in flight at once. The suite raises it to 50 so its own uploads never meet it,
 * which is exactly why nothing else here can reach the refusal.
 */
describe("generation concurrency", () => {
    it("refuses a case once every slot is taken", async () => {
        process.env.GENERATION_MAX_CONCURRENT = "1";

        const first = await uploadOne();
        expect(first.status).toBe("PENDING");

        // The first generation is still hanging, so its slot is still held.
        await expect(uploadOne()).rejects.toBeInstanceOf(GenerationBusyError);

        await pollUntilSettled(first.id);
    });

    it("frees the slot again once that case settles", async () => {
        process.env.GENERATION_MAX_CONCURRENT = "1";

        const first = await uploadOne();
        await pollUntilSettled(first.id);
        for (let attempt = 0; attempt < 50 && generationSlotsInUse() > 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const second = await uploadOne();
        expect(second.status).toBe("PENDING");
        // Settled before the test ends, or its hung generation fails during a
        // later test and that test reads the fallout as its own.
        await pollUntilSettled(second.id);
    });
});

/**
 * What a failed generation owes back. Both halves are invisible to every other
 * test: the images are only written on a path the fixture generator never takes,
 * and the daily budget is charged in the router, one layer above this one.
 */
describe("failed generation", () => {
    it("deletes the images a failed case had already paid for", async () => {
        generation.mode = "failWithKeys";
        generation.storedKeys = ["evidence/one.webp", "evidence/one-thumb.webp"];

        const accepted = await uploadOne();
        expect(await pollUntilSettled(accepted.id)).toBe("FAILED");

        // Nothing else reaps these: the row that referenced them is FAILED and
        // the keys live nowhere else, so a missed reclaim is a paid object
        // orphaned for the life of the bucket.
        expect(vi.mocked(deleteImage).mock.calls.map(([key]) => key)).toStrictEqual([
            "evidence/one.webp",
            "evidence/one-thumb.webp",
        ]);
    });

    it("keeps the daily slot when the failure had already bought images", async () => {
        generation.mode = "failWithKeys";
        generation.storedKeys = ["evidence/one.webp"];

        const accepted = await uploadOne();
        await pollUntilSettled(accepted.id);

        // Images were rendered, so the slot bought something. Refunding here
        // would let a caller pay for images out of an unbounded budget.
        expect(generationDailyBudget.release).not.toHaveBeenCalled();
    });

    it("hands the daily slot back when the failure bought nothing", async () => {
        generation.mode = "failWithKeys";
        generation.storedKeys = [];

        const accepted = await uploadOne();
        await pollUntilSettled(accepted.id);

        // The model being down for ten minutes must not spend the day's budget
        // on generations that rendered nothing and close the court for 24 hours.
        expect(generationDailyBudget.release).toHaveBeenCalledTimes(1);
    });
});
