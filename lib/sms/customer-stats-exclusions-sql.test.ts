import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "..", "migrations", f), "utf8")

describe("migration 20261019_sms_customer_stats_exclusions.sql (static contract)", () => {
  const sql = read("20261019_sms_customer_stats_exclusions.sql")
  const prev = read("20261012_sms_customer_reads.sql")
  const statsFn = (s: string) => {
    const from = s.indexOf("CREATE OR REPLACE FUNCTION sms_customer_stats")
    expect(from).toBeGreaterThanOrEqual(0)
    const rest = s.slice(from)
    return rest.slice(0, rest.indexOf("$$;") + 3).replace(/\s+/g, " ")
  }

  it("is the 20261012 definition with ONLY the two exclusions added (blocked/scheduled kept)", () => {
    const anchor = "AND status NOT IN ('blocked','scheduled');"
    expect(statsFn(prev)).toContain(anchor)
    const expected = statsFn(prev).replace(
      anchor,
      "AND status NOT IN ('blocked','scheduled') AND source <> 'order_confirmation' " +
        "AND NOT (status = 'failed' AND COALESCE(policy_shadow->'review'->>'outcome','') = 'cancelled');",
    )
    expect(statsFn(sql)).toBe(expected)
  })

  it("keeps the signature, return table, LANGUAGE sql STABLE and SECURITY INVOKER", () => {
    const fn = statsFn(sql)
    expect(fn).toMatch(/sms_customer_stats\(p_account_id uuid, p_days int DEFAULT 30\) RETURNS TABLE\(campaigns bigint, recipients bigint, credits_used bigint\) LANGUAGE sql STABLE AS \$\$/)
    expect(fn).not.toMatch(/SECURITY DEFINER/i)
    expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/SECURITY DEFINER/i) // statements only
  })

  it("same grants (service-role only), transactional, with a lock timeout", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION sms_customer_stats\(uuid,int\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION sms_customer_stats\(uuid,int\) TO service_role;/)
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';/m)
    expect(sql.trim().endsWith("COMMIT;")).toBe(true)
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
  })
})
