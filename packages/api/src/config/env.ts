export type AppEnv = "development" | "test" | "production";

/**
 * APP_ENV drives the data source and the prod secret assertions. Defaults to
 * development so a bare `npm run dev` works; production must set it explicitly.
 */
export function resolveAppEnv(): AppEnv {
    const raw = process.env.APP_ENV;
    if (raw === "production" || raw === "test") {
        return raw;
    }
    return "development";
}

/**
 * Refuse to boot as an accidental "development" default when the deploy looks
 * like production (Railway injects DATABASE_URL) but APP_ENV was omitted —
 * otherwise the api silently runs on a container-local sqlite file that dies
 * with the replica.
 */
export function assertAppEnvExplicit(): void {
    if (!process.env.APP_ENV && process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is set but APP_ENV is not. Set APP_ENV=production.");
    }
}

const REQUIRED_IN_PRODUCTION = [
    "DATABASE_URL",
    "CORS_ORIGIN",
    "GEMINI_API_KEY",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_URL",
] as const;

/** Fail fast at boot instead of 500ing on the first upload. */
export function assertProductionEnv(env: AppEnv): void {
    if (env !== "production") {
        return;
    }
    const missing = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required production env: ${missing.join(", ")}`);
    }
}

/**
 * In prod the app (Cloudflare Pages) and api (Railway) are separate origins, so
 * CORS must name the app origin explicitly. Comma-separated for preview domains.
 */
export function resolveCorsOrigin(): string[] {
    const raw = process.env.CORS_ORIGIN;
    if (!raw) {
        return ["http://localhost:5173"];
    }
    return raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
}

/** Reads an env var that is guaranteed present by assertProductionEnv. */
export function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required env: ${key}`);
    }
    return value;
}
