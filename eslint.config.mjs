import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config for all workspaces. Type-aware rules are OFF on purpose: tsc
// covers type correctness and keeps lint fast. `.vue` files are not linted.
export default tseslint.config(
    {
        ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/*.vue"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-non-null-assertion": "error",
            "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
        },
    },
    {
        files: ["**/tests/**", "**/*.test.ts"],
        rules: {
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    },
);
