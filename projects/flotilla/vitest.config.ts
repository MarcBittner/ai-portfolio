import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Node-environment unit tests for the data-access layer (idempotency) and the
// break-glass crypto. Mongo is mocked in-memory (see __tests__/helpers), so these
// run with no Atlas cluster. The `@` alias mirrors tsconfig so `vi.mock` can key
// on the resolved lib/mongo module.
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    globals: false,
    // The masking tests run deterministic Copycat over a full export dir and can
    // take 20-30s under load; the 5s default flakes them. Give real headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
