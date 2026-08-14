import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Dev proxy keeps the browser same-origin: /api forwards to the api on :4270,
// so apiUrl() needs no base URL locally. In production the app (Cloudflare
// Pages) and the api (Railway) are separate origins and apiUrl() prefixes
// VITE_API_URL instead.
export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: "http://localhost:4270",
                changeOrigin: true,
            },
        },
    },
});
