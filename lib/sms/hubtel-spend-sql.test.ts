import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("migration 20261020_sms_hubtel_spend_since.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261020_sms_hubtel_spend_since.sql"), "utf8")
  const fn = sql.match(/CREATE OR REPLACE FUNCTION sms_hubtel_spend_since\([\s\S]*?\$\$;/)![0]
  const body = fn.replace(/\s+/g, " ")

  it("is wrapped in a transaction with a lock timeout", () => {
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/^COMMIT;/m)
  })

  it("signature: (p_since timestamptz, p_default_rate numeric) RETURNS numeric", () => {
    expect(fn).toMatch(/sms_hubtel_spend_since\(p_since timestamptz, p_default_rate numeric\)/i)
    expect(fn).toMatch(/RETURNS numeric/i)
  })

  it("STABLE, SECURITY DEFINER, pinned search_path", () => {
    expect(fn).toMatch(/\bSTABLE\b/)
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = public/)
  })

  it("sums cost_ghs, else segments × the default rate, never NULL", () => {
    expect(body).toMatch(/COALESCE\(sum\(COALESCE\(m\.cost_ghs, m\.segments \* p_default_rate\)\), 0\)/)
  })

  it("only counts Hubtel, non-refunded, non-failed messages", () => {
    expect(body).toMatch(/m\.provider = 'hubtel'/)
    expect(body).toMatch(/NOT m\.refunded/)
    expect(body).toMatch(/m\.status <> 'failed'/)
  })

  it("counts messages created OR sent at/after p_since (a pre-queued message sent later still costs)", () => {
    expect(body).toMatch(/\(m\.created_at >= p_since OR m\.processed_at >= p_since\)/)
  })

  it("rejects bad inputs instead of silently returning 0", () => {
    expect(body).toMatch(/p_since IS NULL/)
    expect(body).toMatch(/p_default_rate IS NULL OR p_default_rate <= 0/)
    expect(body).toMatch(/RAISE EXCEPTION/)
  })

  it("revokes from public roles and grants service_role only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION sms_hubtel_spend_since\(timestamptz, numeric\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT\s+EXECUTE ON FUNCTION sms_hubtel_spend_since\(timestamptz, numeric\) TO service_role;/)
    expect(sql).not.toMatch(/TO (anon|authenticated)/)
  })
})
