import { defineConfig } from "vitest/config"
import path from "path"

// Unit tests only (pure functions / logic). No DB or network — modules that
// instantiate a Supabase client at import time get harmless placeholder env from
// vitest.setup.ts so the import doesn't throw.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  // tsconfig keeps `jsx: preserve` for Next; a test that renders a component to static markup needs it compiled.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
})
