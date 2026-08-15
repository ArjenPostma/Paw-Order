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
        // The generation ceilings are raised so the suite's own uploads do not
        // trip the limiter - the limiter itself is unit-tested in rate_limit.test.ts.
        env: {
            APP_ENV: "test",
            GENERATION_MAX_PER_MINUTE: "1000",
            GENERATION_MAX_PER_IP_PER_DAY: "1000",
            GENERATION_MAX_PER_DAY: "1000",
            GENERATION_MAX_CONCURRENT: "50",
        },
    },
});
