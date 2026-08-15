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
    //
    // 1, not true: `true` trusts the whole X-Forwarded-For chain and resolves
    // req.ip to its LEFTMOST entry, which the client writes. The per-ip rate
    // limit keys on req.ip, so any caller could mint a fresh bucket per request
    // and the cap would never fire. One hop is what Railway's edge actually adds.
    if (process.env.TRUST_PROXY === "true") {
        app.set("trust proxy", 1);
    }

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    app.use("/api/cases", casesRouter);

    // Last resort: log the detail server-side, return a generic body. Express 5
    // routes rejected async handlers here automatically.
    const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
        // express.json reports a malformed or oversized body by throwing an
        // error carrying its own 4xx status. Reporting those as 500 tells the
        // caller the server broke when in fact their request did, and writes a
        // stack trace per hit - an anonymous caller choosing the log volume.
        const status =
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            typeof error.status === "number" &&
            error.status >= 400 &&
            error.status < 500
                ? error.status
                : 500;

        if (status === 500) {
            console.error("[paw-order-api] unhandled error", error);
        }
        // Once the response has started, setting a status throws
        // ERR_HTTP_HEADERS_SENT; Express's default handler destroys the socket
        // instead of leaving it half-written.
        if (res.headersSent) {
            next(error);
            return;
        }
        res.status(status).json({
            error: status === 500 ? "Something went wrong." : "That request could not be read.",
        });
    };
    app.use(errorHandler);

    return app;
}
