import cors from "cors";
import express from "express";
import type { ErrorRequestHandler, Express } from "express";
import { resolveCorsOrigin } from "@/config/env";
import { casesRouter } from "@/cases_bundle/router";

export function createApp(): Express {
    const app = express();

    // Nothing here should ever be content-sniffed, and the framework banner is
    // free reconnaissance.
    app.disable("x-powered-by");
    app.use((_req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        next();
    });

    app.use(cors({ origin: resolveCorsOrigin() }));
    app.use(express.json({ limit: "1mb" }));

    // Behind Railway's edge in prod, so req.ip must come from X-Forwarded-For.
    // Gated on TRUST_PROXY=true (set on Railway); unset in dev leaves Express's
    // default so req.ip is the local socket.
    if (process.env.TRUST_PROXY === "true") {
        app.set("trust proxy", true);
    }

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    app.use("/api/cases", casesRouter);

    // Last resort: log the detail server-side, return a generic body. Express 5
    // routes rejected async handlers here automatically.
    const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
        console.error("[paw-order-api] unhandled error", error);
        // Once the response has started, setting a status throws
        // ERR_HTTP_HEADERS_SENT; Express's default handler destroys the socket
        // instead of leaving it half-written.
        if (res.headersSent) {
            next(error);
            return;
        }
        res.status(500).json({ error: "Something went wrong." });
    };
    app.use(errorHandler);

    return app;
}
