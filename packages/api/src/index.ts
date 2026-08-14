import "reflect-metadata";
import { createApp } from "@/app";
import { assertAppEnvExplicit, assertProductionEnv, resolveAppEnv } from "@/config/env";

const PORT = Number(process.env.PORT ?? 4270);

async function main(): Promise<void> {
    assertAppEnvExplicit();
    assertProductionEnv(resolveAppEnv());

    // Imported dynamically, and only after the assertions: data_source.ts builds
    // AppDataSource at module-evaluation time, so a static import would throw
    // "DATABASE_URL is required" during the import and pre-empt the aggregated
    // list of everything that is actually missing.
    const { AppDataSource } = await import("@/database_bundle/util/data_source");
    await AppDataSource.initialize();

    const server = createApp().listen(PORT, () => {
        console.log(`[paw-order-api] listening on http://localhost:${PORT}`);
    });
    // listen() reports failures (e.g. EADDRINUSE) via an async 'error' event,
    // not the success callback - handle it or Node throws it uncaught.
    server.on("error", (error: unknown) => {
        console.error("[paw-order-api] failed to bind port", error);
        process.exit(1);
    });
}

main().catch((error: unknown) => {
    console.error("[paw-order-api] failed to boot", error);
    process.exit(1);
});
