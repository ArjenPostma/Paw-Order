import "reflect-metadata";
import { assertAppEnvExplicit, assertProductionEnv, resolveAppEnv } from "@/config/env";

const PORT = Number(process.env.PORT ?? 4270);

async function main(): Promise<void> {
    assertAppEnvExplicit();
    assertProductionEnv(resolveAppEnv());

    // Every import below is dynamic, and every one of them has to stay that way:
    // data_source.ts builds AppDataSource at module-evaluation time, so a static
    // import anywhere in this file - including one that only reaches it through
    // app.ts's router - throws "DATABASE_URL is required" during the import and
    // pre-empts the aggregated list of everything that is actually missing.
    const { AppDataSource } = await import("@/database_bundle/util/data_source");
    await AppDataSource.initialize();

    const { createApp } = await import("@/app");
    const { startCaseRetention, sweepStalePendingCases } =
        await import("@/cases_bundle/services/case_service");

    const server = createApp().listen(PORT, () => {
        console.log(`[paw-order-api] listening on http://localhost:${PORT}`);
    });
    // listen() reports failures (e.g. EADDRINUSE) via an async 'error' event,
    // not the success callback - handle it or Node throws it uncaught.
    server.on("error", (error: unknown) => {
        console.error("[paw-order-api] failed to bind port", error);
        process.exit(1);
    });

    // After listen(), never before: this is a full scan of the cases table -
    // nothing indexes status or createdAt - and blocking the port on it would
    // let a housekeeping query fail the platform's health check. Nothing it
    // touches can be a row this process created, so it is safe to run while
    // requests are already being served.
    sweepStalePendingCases();
    // Same reasoning, and the same full scan: retention only ever touches rows
    // older than a year, so nothing this process is serving is in its way.
    startCaseRetention();
}

main().catch((error: unknown) => {
    console.error("[paw-order-api] failed to boot", error);
    process.exit(1);
});
