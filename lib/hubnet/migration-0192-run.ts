// Builds the self-rolling-back dry-run string for migrations/0192_hubnet_ref_reservations.sql (prod runbook, Step 1).
// Pure and dependency-free so both the vitest suite and a runbook script use the same code.
// Never hand-build this string: the 0130 incident came from a hand-built dry run that could commit.

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
export const code = (sql: string): string => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

/**
 * The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on.
 * Throws unless the result has no COMMIT, no bare END; and ends by raising SELFTEST_OK.
 */
export function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0192:no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0192:run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0192:run string does not end by raising")
  return run
}
