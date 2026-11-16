/**
 * Prints the self-rolling-back dry-run SQL for migration 0182 to stdout (docs/blocked-numbers-runbook.md, Step 1).
 * The same builder and assertions as lib/blocked-numbers/migration-0182.test.ts run first; it exits non-zero
 * (printing nothing) if the string could commit.
 *
 *   npx tsx scripts/print-0182-selftest.ts > 0182-selftest-run.sql
 */

import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString } from "../lib/blocked-numbers/migration-0182-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")

process.stdout.write(buildRunString(read("0182_mtn_blocked_numbers.sql"), read("0182_mtn_blocked_numbers.selftest.sql")) + "\n")
