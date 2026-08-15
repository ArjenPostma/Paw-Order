import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppDataSource } from "@/database_bundle/util/data_source";
import { CaseEntity } from "@/cases_bundle/models/case_entity";
import { createCase, generationSlotsInUse } from "@/cases_bundle/services/case_service";

// The deadline is read once at module load, so lowering it has to happen before
// case_service is imported. vi.hoisted runs ahead of the imports above; 50ms is
// long enough that the row is inserted first and short enough to sit inside a
// normal test timeout.
vi.hoisted(() => {
    process.env.GENERATION_TIMEOUT_MS = "50";
});

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
                signal.addEventListener("abort", () => {
                    reject(new Error("hung generation aborted"));
                });
            }),
    };
});

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

describe("generation deadline", () => {
    it("fails a case whose generation never returns", async () => {
        const accepted = await createCase({ bytes: PNG_1X1, mimeType: "image/png" }, "Rex", null);
        expect(accepted.status).toBe("PENDING");

        expect(await pollUntilSettled(accepted.id)).toBe("FAILED");
    });

    it("releases the generation slot when the deadline fires", async () => {
        const accepted = await createCase({ bytes: PNG_1X1, mimeType: "image/png" }, "Rex", null);
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
