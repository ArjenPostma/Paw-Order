import "reflect-metadata";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { AppDataSource } from "@/database_bundle/util/data_source";

// Smallest valid PNG (1x1, transparent).
const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

const app = createApp();

beforeAll(async () => {
    await AppDataSource.initialize();
});

afterAll(async () => {
    await AppDataSource.destroy();
});

describe("api wiring", () => {
    it("serves /health", async () => {
        const response = await request(app).get("/health");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });

    it("rejects a case request with no photo", async () => {
        const response = await request(app).post("/api/cases");
        expect(response.status).toBe(400);
    });

    it("persists an uploaded case and serves it back without the hidden truth", async () => {
        const created = await request(app)
            .post("/api/cases")
            .attach("photo", PNG_1X1, { filename: "dog.png", contentType: "image/png" });

        expect(created.status).toBe(201);
        expect(created.body.id).toBeTruthy();
        expect(created.body.truth).toBeUndefined();

        const fetched = await request(app).get(`/api/cases/${created.body.id}`);
        expect(fetched.status).toBe(200);
        expect(fetched.body.id).toBe(created.body.id);
        expect(fetched.body.truth).toBeUndefined();
        expect(fetched.body.defendant.photoUrl).toContain("data:image/png");
    });

    it("404s an unknown case", async () => {
        const response = await request(app).get("/api/cases/2f1a2b3c-0000-4000-8000-000000000000");
        expect(response.status).toBe(404);
    });
});
