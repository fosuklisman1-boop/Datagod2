// Builds the self-rolling-back dry-run string for migrations/0200_api_webhooks.sql (prod runbook, dry-run step).
// Same rules as migration-0199-run.ts (the 0130 incident came from a hand-built dry run that could commit); only the
// label differs, so the helpers are shared from there.
import { code, withoutDollarBodies } from "./migration-0198-run"

export { code, withoutDollarBodies }

const TXN_END = /\b(END\s*(;|\s+(TRANSACTION|WORK|TRAN)\b)|ABORT\b|ROLLBACK\b|PREPARE\s+TRANSACTION\b)/i

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. Throws unless safe. */
export function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0200:no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const doBlock = st.slice(doAt).join("\n")
  const run = head + "\n" + doBlock

  if (/\bCOMMIT\b/i.test(run)) throw new Error("0200:run string could commit")
  const lead = run.replace(/^(\s|--[^\n]*\n)*/, "")
  if (!/^BEGIN;\s*(--[^\n]*\n\s*)*SET LOCAL lock_timeout = '[^']*';\s*(--[^\n]*\n\s*)*SET LOCAL statement_timeout = '[^']*';/.test(lead)) {
    throw new Error("0200:run string must begin with BEGIN; and both SET LOCAL lines")
  }
  if (TXN_END.test(withoutDollarBodies(head))) throw new Error("0200:migration part has a transaction-ending statement outside a function body")
  if (TXN_END.test(doBlock)) throw new Error("0200:selftest has a transaction-ending statement")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(run)) throw new Error("0200:run string does not end by raising")
  return run
}
