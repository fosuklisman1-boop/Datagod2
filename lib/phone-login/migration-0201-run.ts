// Builds the self-rolling-back dry-run string for migrations/0201_phone_login.sql (prod runbook, Step 1).
// Same contract as lib/ai-admin-catalog/migration-0196-run.ts; the shared helpers are reused, only the error prefix differs.
// Never hand-build this string: the 0130 incident came from a hand-built dry run that could commit.
import { buildRunString as build0189, code, withoutDollarBodies } from "../ai-console/migration-0189-run"

export { code, withoutDollarBodies }

export function buildRunString(migrationSql: string, selftestSql: string): string {
  try {
    return build0189(migrationSql, selftestSql)
  } catch (e) {
    throw new Error(String((e as Error).message).replace(/^0189:/, "0201:"))
  }
}
