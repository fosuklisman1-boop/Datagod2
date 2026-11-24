// Builds the self-rolling-back dry-run string for migrations/0197_api_admin_console.sql (prod runbook, dry-run step).
// Pure and dependency-free so both the vitest suite and any print script use the same code.
// Never hand-build this string: the 0130 incident came from a hand-built dry run that could commit.

/** SQL with `--` comments removed. Only for display/assertions on shape; NEVER used for a safety check (a `'--'` literal fools it). */
export const code = (sql: string): string => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

/** Blanks every dollar-quoted body ($$...$$, $fn$...$fn$): a function body legitimately contains `END;`. A digit-leading tag is not a dollar quote. */
export const withoutDollarBodies = (sql: string): string => sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "$$$$")

/** Any statement that could end the surrounding transaction early (checked on raw text, outside dollar-quoted bodies). */
const TXN_END = /\b(END\s*(;|\s+(TRANSACTION|WORK|TRAN)\b)|ABORT\b|ROLLBACK\b|PREPARE\s+TRANSACTION\b)/i

/**
 * The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on.
 * All checks run on the RAW text (no comment stripping, so a `'--'` literal cannot hide anything). Throws unless:
 * the run string begins with BEGIN; and both SET LOCALs; contains no COMMIT anywhere; has no transaction-ending statement
 * (END;, END TRANSACTION/WORK/TRAN, ABORT, ROLLBACK, PREPARE TRANSACTION) outside dollar-quoted function bodies; the self-test
 * DO block (bodies included) has none either; and the run string ends by raising SELFTEST_OK.
 */
export function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0197:no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const doBlock = st.slice(doAt).join("\n")
  const run = head + "\n" + doBlock

  if (/\bCOMMIT\b/i.test(run)) throw new Error("0197:run string could commit")
  const lead = run.replace(/^(\s|--[^\n]*\n)*/, "")
  if (!/^BEGIN;\s*(--[^\n]*\n\s*)*SET LOCAL lock_timeout = '[^']*';\s*(--[^\n]*\n\s*)*SET LOCAL statement_timeout = '[^']*';/.test(lead)) {
    throw new Error("0197:run string must begin with BEGIN; and both SET LOCAL lines")
  }
  if (TXN_END.test(withoutDollarBodies(head))) throw new Error("0197:migration part has a transaction-ending statement outside a function body")
  if (TXN_END.test(doBlock)) throw new Error("0197:selftest has a transaction-ending statement")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(run)) throw new Error("0197:run string does not end by raising")
  return run
}
