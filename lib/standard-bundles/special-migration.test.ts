// lib/standard-bundles/special-migration.test.ts
// Static checks on migrations/0141_special_bundles.sql and its self-test. The SQL itself runs only in the
// self-rolling-back dry run (prod change protocol); these tests pin the money-critical shape so an edit that
// drops the wallet lock, reorders the replay check, widens the grants or breaks the run-string rules fails CI.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

// CRLF -> LF: the repo checks migrations out with CRLF, and `--.*$` would not strip a comment ending in "\r".
const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const MIGRATION = read("0141_special_bundles.sql")
const SELFTEST = read("0141_special_bundles.selftest.sql")
const SIG = "public.create_special_bundle_orders(uuid, text, integer, jsonb, numeric)"

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")

/** The function body between `AS $fn$` and the closing `$fn$;`. */
function rpcBody(): string {
  const m = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.create_special_bundle_orders\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/)
  if (!m) throw new Error("0141: create_special_bundle_orders body not found")
  return code(m[1])
}

/** House run string: migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function runString(): string {
  const lines = MIGRATION.split("\n")
  const commitAt = lines.map(l => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0141: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = SELFTEST.split("\n")
  const doAt = st.findIndex(l => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  return head + "\n" + st.slice(doAt).join("\n")
}

describe("0141 migration text", () => {
  it("is one transaction with lock and statement timeouts and exactly one COMMIT", () => {
    const c = code(MIGRATION)
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("adds the two nullable columns and the group index idempotently", () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS special_group_id\s+uuid\b/)
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS special_index\s+smallint\b/)
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_hubtel_data_orders_special_child\s+ON public\.hubtel_data_orders \(special_group_id, special_index\)\s+WHERE special_group_id IS NOT NULL/)
  })

  it("is SECURITY DEFINER with a pinned search_path, executable by service_role only", () => {
    const head = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.create_special_bundle_orders\(([\s\S]*?)AS \$fn\$/)
    expect(head).not.toBeNull()
    expect(head![1]).toMatch(/p_user\s+uuid,\s*p_group_key\s+text,\s*p_n\s+integer,\s*p_rows\s+jsonb,\s*p_total\s+numeric/)
    // the pre-p_n draft signature is dropped idempotently, before the CREATE
    const drop = MIGRATION.indexOf("DROP FUNCTION IF EXISTS public.create_special_bundle_orders(uuid, text, jsonb, numeric);")
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(MIGRATION.indexOf("CREATE OR REPLACE FUNCTION public.create_special_bundle_orders("))
    expect(head![1]).toMatch(/RETURNS jsonb/)
    expect(head![1]).toMatch(/SECURITY DEFINER/)
    expect(head![1]).toMatch(/SET search_path = public/)
    expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated;`)
    expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role;`)
    expect(code(MIGRATION).match(/GRANT EXECUTE ON FUNCTION public\.create_special_bundle_orders/g)).toHaveLength(1)
  })

  it("locks the wallet, then checks for the group, then validates, then debits, then inserts", () => {
    const b = rpcBody()
    const lock = b.search(/FROM public\.wallets[^;]*FOR UPDATE/)
    const replay = b.search(/idempotency_key = p_group_key \|\| ':1'/)
    const total = b.search(/v_sum <> p_total/)
    const debit = b.search(/FROM public\.deduct_wallet\(p_user, p_total\)/)
    const insert = b.search(/INSERT INTO public\.hubtel_data_orders/)
    for (const at of [lock, replay, total, debit, insert]) expect(at).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(replay)
    expect(replay).toBeLessThan(total)
    expect(total).toBeLessThan(debit)
    expect(debit).toBeLessThan(insert)
    // exactly one wallet debit per call
    expect(b.match(/deduct_wallet\(/g)).toHaveLength(1)
    expect(b.match(/INSERT INTO public\.transactions/g)).toHaveLength(1)
  })

  it("leaves each child exactly as data_order_debit leaves a dashboard order (pending + paid)", () => {
    const b = rpcBody()
    expect(b).toMatch(/'dashboard'/)
    expect(b).toMatch(/'pending',\s*'paid'/)
    expect(b).toMatch(/p_group_key \|\| ':' \|\| v_i/)
    expect(b).toMatch(/'debit',\s*'standard_bundle'/)
    expect(b).toMatch(/'completed'/)
  })

  it("raises the two error codes and checks every input listed in Review Focus 5", () => {
    const b = rpcBody()
    expect(b).toMatch(/RAISE EXCEPTION 'INSUFFICIENT_FUNDS'/)
    expect(b).toMatch(/RAISE EXCEPTION 'BAD_INPUT'/)
    expect(b).toMatch(/p_n IS NULL OR p_n < 1 OR p_n > 50/)
    expect(b).toMatch(/v_n := jsonb_array_length\(p_rows\);\s*IF v_n <> p_n THEN/)
    expect(b).toMatch(/v_paid <> v_amount - COALESCE\(\(v_unit ->> 'cashback_amount'\)::numeric, 0\)/)
    expect(b).toMatch(/v_num <> round\(v_num, 2\)/)
    expect(b).toMatch(/'MTN'/)
    expect(b).toMatch(/'data_mtn'/)
    expect(b).toMatch(/\^233\[0-9\]\{9\}\$/)
    expect(b).toMatch(/round\(v_amount, 2\)/)
    expect(b).toMatch(/round\(v_paid, 2\)/)
  })
})

describe("0141 run string (migration + self-test)", () => {
  it("has no COMMIT and no bare END; statement, and ends with the always-raising DO block", () => {
    const s = code(runString())
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("self-test covers happy path, replay, short wallet, bad total, n bounds and the grants", () => {
    for (const label of ["happy", "replay", "short_wallet", "bad_total", "n_zero", "n_51", "n_mismatch", "paid_not_face_minus_cashback",
                         "three_dp_cashback", "three_dp_shop_share", "negative_shop_share", "key_used_by_normal_order",
                         "deny_anon", "deny_authenticated"]) {
      expect(SELFTEST).toContain(label)
    }
  })
})
