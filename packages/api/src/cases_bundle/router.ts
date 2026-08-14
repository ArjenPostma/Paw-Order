import { Router } from "express";
import type { RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { createCase, findPublicCase } from "@/cases_bundle/services/case_service";
import { rateLimit } from "@/http/rate_limit";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_REQUIRED = "A photo (jpeg, png or webp, max 8MB) is required.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Memory storage: the photo goes straight to R2, it never touches local disk.
// fields/parts matter as much as fileSize - busboy defaults them to Infinity, so
// capping only the file leaves the multipart body as a whole unbounded (and
// express.json's limit never applies to multipart).
const upload = multer({
    storage: multer.memoryStorage(),
    // parts is 2, not 1: busboy's counter rejects a lone file part at parts:1,
    // so 1 breaks every valid upload. fields:0 is what actually stops the
    // "one tiny file plus 100k text fields" body, files:1 the extra files.
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1, parts: 2, fields: 0 },
    fileFilter: (_req, file, callback) => {
        // Client-declared mime type is a hint, not proof - it caps the obvious
        // junk; the size limit is what actually bounds the request.
        callback(null, ALLOWED_MIME_TYPES.has(file.mimetype));
    },
});

/**
 * multer signals every limit violation through next(err), which skips the route
 * handler entirely and lands on the generic error handler as a 500. Translate
 * those to the 400 the caller can act on, and keep real errors flowing.
 */
const uploadPhoto: RequestHandler = (req, res, next) => {
    upload.single("photo")(req, res, (error: unknown) => {
        if (error instanceof MulterError) {
            res.status(400).json({ error: PHOTO_REQUIRED });
            return;
        }
        next(error);
    });
};

// Generation is anonymous and writes to paid storage, so the endpoint is capped
// per ip and per day. Without this one caller can fill the bucket and the table,
// and once the generator makes real model calls, the bill with it. Both ceilings
// are env-tunable so a load test (or the suite) can raise them without editing code.
const generationLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.GENERATION_MAX_PER_MINUTE ?? 1),
    dailyMax: Number(process.env.GENERATION_MAX_PER_DAY ?? 50),
});

export const casesRouter = Router();

casesRouter.post("/", generationLimiter, uploadPhoto, async (req, res) => {
    const file = req.file;
    if (!file) {
        res.status(400).json({ error: PHOTO_REQUIRED });
        return;
    }

    const publicCase = await createCase({ bytes: file.buffer, mimeType: file.mimetype });
    res.status(201).json(publicCase);
});

casesRouter.get("/:id", async (req, res) => {
    const id = req.params.id;
    // The column is uuid on Postgres and varchar on sqlite: without this check a
    // malformed id is a clean miss in dev and a 22P02 driver error (surfacing as
    // a 500, plus a stack trace per crawler hit) in production.
    if (!id || !UUID_PATTERN.test(id)) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    const publicCase = await findPublicCase(id);
    if (!publicCase) {
        res.status(404).json({ error: "Case not found." });
        return;
    }

    // A generated case never changes, so a reload should not re-fetch it.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.json(publicCase);
});
