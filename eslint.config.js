import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "runs/**", "evidence/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  },
  {
    // Replay is the model-free production path: it must never gain a runtime
    // dependency on the LLM layer. Type-only contracts remain allowed.
    files: ["src/replay/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{ group: ["**/agent/**"], message: "Deterministic replay must not depend on the LLM layer.", allowTypeImports: true }]
      }]
    }
  }
);
