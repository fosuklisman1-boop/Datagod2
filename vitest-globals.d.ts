// Makes vitest's global test APIs (describe/it/expect/vi) visible to tsc, so
// test files that rely on `globals: true` typecheck without per-file imports.
/// <reference types="vitest/globals" />
