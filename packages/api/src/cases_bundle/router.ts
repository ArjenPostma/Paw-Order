import { Router } from "express";
import multer from "multer";
import { createCase, findPublicCase } from "@/cases_bundle/services/case_service";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Memory storage: the photo goes straight to R2, it never touches local disk.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
    fileFilter: (_req, file, callback) => {
        // Client-declared mime type is a hint, not proof — it caps the obvious
        // junk; the size limit is what actually bounds the request.
        callback(null, ALLOWED_MIME_TYPES.has(file.mimetype));
    },
});

export const casesRouter = Router();

casesRouter.post("/", upload.single("photo"), async (req, res) => {
    const file = req.file;
    if (!file) {
        res.status(400).json({ error: "A photo (jpeg, png or webp, max 8MB) is required." });
        return;
    }

    const publicCase = await createCase({ bytes: file.buffer, mimeType: file.mimetype });
    res.status(201).json(publicCase);
});

casesRouter.get("/:id", async (req, res) => {
    const id = req.params.id;
    if (!id) {
        res.status(400).json({ error: "A case id is required." });
        return;
    }

    const publicCase = await findPublicCase(id);
    if (!publicCase) {
        res.status(404).json({ error: "Case not found." });
        return;
    }
    res.json(publicCase);
});
