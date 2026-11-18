// Builds the self-rolling-back dry-run string for migrations/0185_role_price_sql.sql (prod runbook, Step 1).
// Pure and dependency-free so both the vitest suite and any print script use the same code.
// Never hand-build this string: the 0130 incident came from a hand-built dry run that could commit.

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
export const code = (sql: string): string => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

/** Blanks every dollar-quoted body ($$...$$, $fn$...$fn$): a function body legitimately contains `END;`. */
export const withoutDollarBodies = (sql: string): string => sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "$$$$")

/**
 * The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on.
 * Throws unless: no COMMIT anywhere (comments aside), no bare END; outside dollar-quoted function bodies,
 * and the self-test DO block (checked strictly, bodies included) has no bare END; and ends by raising SELFTEST_OK.
 */
export function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0185:no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const doBlock = st.slice(doAt).join("\n")
  const run = head + "\n" + doBlock
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c)) throw new Error("0185:run string could commit")
  if (/^\s*END\s*;/im.test(withoutDollarBodies(code(head)))) throw new Error("0185:migration part has a bare END; outside a function body")
  if (/^\s*END\s*;/im.test(code(doBlock))) throw new Error("0185:selftest has a bare END;")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0185:run string does not end by raising")
  return run
}
