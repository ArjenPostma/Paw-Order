import "reflect-metadata";
// Load packages/api/.env for local runs (dev server + typeorm CLI). dotenv does
// NOT override real environment variables, so prod (Railway injects env) and
// tests (vitest sets APP_ENV) are unaffected; a missing .env is a no-op.
import "dotenv/config";
import { DataSource } from "typeorm";
import type { DataSourceOptions } from "typeorm";
import { entities } from "@/entities";
import { resolveAppEnv } from "@/config/env";
import type { AppEnv } from "@/config/env";

export function getDataSourceOptions(env: AppEnv = resolveAppEnv()): DataSourceOptions {
    switch (env) {
        case "development":
            return {
                type: "better-sqlite3",
                database: "database.sqlite",
                synchronize: true,
                entities,
            };
        case "test":
            return {
                type: "better-sqlite3",
                database: ":memory:",
                synchronize: true,
                dropSchema: true,
                entities,
            };
        case "production": {
            const url = process.env.DATABASE_URL;
            if (!url) {
                throw new Error("DATABASE_URL is required when APP_ENV=production");
            }
            return {
                type: "postgres",
                url,
                synchronize: false,
                entities,
                migrations: ["dist/database_bundle/migrations/*.js"],
                extra: { statement_timeout: 60_000, connectionTimeoutMillis: 10_000 },
            };
        }
    }
}

// ponytail: no sqlite transaction-serialize wrapper. better-sqlite3 shares one
// QueryRunner, so concurrent dataSource.transaction() calls corrupt its depth
// counter — add the FIFO wrapper if this api ever runs concurrent transactions.

// ponytail: migrations run from the container start command with no advisory
// lock, which is safe at ONE replica only. Two replicas both see the migration
// pending, both execute it, and the loser dies on 42P07 while /health still
// reports the survivor healthy. Take a pg advisory lock (or move migrations to a
// Railway pre-deploy step, which runs once) before scaling past one.

// Entity changes reach dev and test through synchronize:true but reach
// production ONLY through a generated migration, and CI runs on sqlite - so a
// missing migration is invisible to `npm run all`. Run `npm run typeorm:generate`
// against a prod-shaped database whenever an entity changes.

// Single DataSource export: the app boots from it and the typeorm CLI (`-d`)
// resolves it as the one DataSource instance in this file.
export const AppDataSource = new DataSource(getDataSourceOptions());
