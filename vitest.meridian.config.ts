import { defineConfig } from "vitest/config";

// Opt-in live suite: runs ONLY the MERIDIAN tests, which hit the hosted app and
// need credentials in the environment. `npm test` never includes these.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    // A live sign-on, form loads and replays are slower than any offline test.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
