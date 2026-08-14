import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        // In-memory sqlite + dropSchema; must be set before data_source loads.
        env: { APP_ENV: "test" },
    },
});
