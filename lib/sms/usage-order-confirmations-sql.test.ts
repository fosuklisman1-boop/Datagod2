import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "..", "migrations", f), "utf8")

describe("migration 20261018_sms_usage_exclude_order_confirmations.sql (static contract)", () => {
  const sql = read("20261018_sms_usage_exclude_order_confirmations.sql")
  const prev = read("20261016_sms_scheduled_sends.sql")
  const usageFn = (s: string) => {
    const from = s.indexOf("CREATE OR REPLACE FUNCTION sms_account_usage")
    expect(from).toBeGreaterThanOrEqual(0)
    const rest = s.slice(from)
    return rest.slice(0, rest.indexOf("$$;") + 3).replace(/\s+/g, " ")
  }

  it("is the 20261016 definition with ONLY the order_confirmation exclusion added", () => {
    const expected = usageFn(prev).replace("AND status <> 'blocked'", "AND status <> 'blocked' AND source <> 'order_confirmation'")
    expect(expected).not.toBe(usageFn(prev)) // the anchor exists
    expect(usageFn(sql)).toBe(expected)
  })

  it("keeps the signature, STABLE, SECURITY DEFINER and the pinned search_path", () => {
    const fn = usageFn(sql)
    expect(fn).toMatch(/sms_account_usage\(p_account_id UUID\) RETURNS TABLE\(sends_last_hour INT, recipients_last_24h BIGINT\)/)
    expect(fn).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$\$/)
  })

  it("is service-role only, transactional, with a lock timeout", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION sms_account_usage\(UUID\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION sms_account_usage\(UUID\) TO service_role;/)
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';/m)
    expect(sql.trim().endsWith("COMMIT;")).toBe(true)
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
  })
})
