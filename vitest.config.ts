import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: { reporter: ["text", "json-summary"] },
    // Live MERIDIAN tests hit the hosted app and need credentials, so they never
    // run in the default suite. `npm run test:meridian` opts into them explicitly.
    exclude: ["node_modules/**", "dist/**", "tests/live/**"]
  }
});
