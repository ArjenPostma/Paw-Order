/**
 * Longest edge of what actually leaves the browser.
 *
 * Nothing paints the uploaded photo larger than the 224px mugshot, and the only
 * consumer that wants real pixels is the image model, which renders its exhibits
 * from a reference this size. An 8MB phone photo is 99% waste on both counts.
 */
const MAX_EDGE = 1024;

/** JPEG, not WebP: Safari could not encode WebP to a canvas until 16.4. */
const ENCODED_TYPE = "image/jpeg";
const QUALITY = 0.85;

/**
 * Shrinks a photo before upload, or hands back the original.
 *
 * Never throws and never rejects a file. Every failure path - an image the
 * browser cannot decode, a canvas that gives up, a re-encode that came out
 * bigger than what it replaced - returns the file untouched, because the api
 * accepts that file today and a resize is an optimisation, not a gate.
 */
export async function downscale(file: File): Promise<File> {
    try {
        // from-image, not the default: the canvas re-encode below drops EXIF, so
        // a portrait phone photo whose rotation lives only in that tag would be
        // uploaded sideways - to the mugshot and to the image model both.
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        let blob;
        try {
            const scale = MAX_EDGE / Math.max(bitmap.width, bitmap.height);
            if (scale >= 1) {
                return file;
            }

            const canvas = document.createElement("canvas");
            canvas.width = Math.round(bitmap.width * scale);
            canvas.height = Math.round(bitmap.height * scale);
            const context = canvas.getContext("2d");
            if (!context) {
                return file;
            }
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

            blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob(resolve, ENCODED_TYPE, QUALITY);
            });
        } finally {
            // finally, not a call per exit: a throw between the decode and here
            // happens under memory pressure, which is the worst moment to leak
            // a decoded bitmap.
            bitmap.close();
        }
        if (!blob || blob.size >= file.size) {
            return file;
        }
        // The name is cosmetic - the api derives the extension from the content
        // type it is given, never from what the file called itself.
        return new File([blob], file.name, { type: ENCODED_TYPE });
    } catch {
        return file;
    }
}
