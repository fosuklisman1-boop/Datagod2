import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "..", "migrations", f), "utf8")
const squash = (s: string) => s.replace(/\s+/g, " ").trim()

describe("migration 20261022_sms_hubtel_per_segment_rate.sql (static contract)", () => {
  const sql = read("20261022_sms_hubtel_per_segment_rate.sql")
  const prev = read("20261020_sms_hubtel_spend_since.sql")

  it("is wrapped in a transaction with a lock timeout", () => {
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/^COMMIT;/m)
  })

  describe("sms_hubtel_max_rate(p_days int)", () => {
    const fn = sql.match(/CREATE OR REPLACE FUNCTION sms_hubtel_max_rate\([\s\S]*?\$\$;/)![0]
    const body = squash(fn)
    it("signature + attributes", () => {
      expect(fn).toMatch(/sms_hubtel_max_rate\(p_days int\)/i)
      expect(fn).toMatch(/RETURNS numeric/i)
      expect(fn).toMatch(/\bSTABLE\b/)
      expect(fn).toMatch(/SECURITY DEFINER/)
      expect(fn).toMatch(/SET search_path = public/)
    })
    it("returns the highest PER-SEGMENT price: max(cost_ghs / segments)", () => {
      expect(body).toMatch(/SELECT max\(m\.cost_ghs \/ m\.segments\) FROM sms_messages m/)
    })
    it("only Hubtel rows with a reported cost and segments > 0, in the window by processed_at", () => {
      expect(body).toMatch(/m\.provider = 'hubtel'/)
      expect(body).toMatch(/m\.cost_ghs IS NOT NULL/)
      expect(body).toMatch(/m\.segments > 0/)
      expect(body).toMatch(/m\.processed_at >= now\(\) - make_interval\(days => GREATEST\(p_days, 1\)\)/)
    })
    it("service_role only", () => {
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION sms_hubtel_max_rate\(int\) FROM PUBLIC, anon, authenticated;/)
      expect(sql).toMatch(/GRANT\s+EXECUTE ON FUNCTION sms_hubtel_max_rate\(int\) TO service_role;/)
    })
  })

  describe("sms_hubtel_spend_since re-definition", () => {
    const fnOf = (s: string) => s.match(/CREATE OR REPLACE FUNCTION sms_hubtel_spend_since\([\s\S]*?\$\$;/)![0]
    const OLD = "sum(m.segments * GREATEST(COALESCE(m.cost_ghs, 0), p_default_rate))"
    const NEW = "sum(GREATEST(COALESCE(m.cost_ghs, 0), m.segments * p_default_rate))"

    it("prices each sms_messages row as max(whole-message cost, segments × per-segment default)", () => {
      expect(squash(fnOf(sql))).toContain(NEW)
      expect(squash(fnOf(sql))).not.toContain(OLD)
    })
    it("is otherwise byte-identical to the applied 20261020 definition", () => {
      expect(fnOf(prev)).toContain(OLD)
      expect(fnOf(sql)).toBe(fnOf(prev).replace(OLD, NEW))
    })
    it("keeps the same grants and the same index", () => {
      for (const line of [
        "REVOKE ALL ON FUNCTION sms_hubtel_spend_since(timestamptz, numeric) FROM PUBLIC, anon, authenticated;",
        "GRANT  EXECUTE ON FUNCTION sms_hubtel_spend_since(timestamptz, numeric) TO service_role;",
      ]) {
        expect(prev).toContain(line)
        expect(sql).toContain(line)
      }
      const idx = (s: string) => squash(s.match(/CREATE INDEX IF NOT EXISTS idx_sms_messages_hubtel_sent[\s\S]*?;/)![0])
      expect(idx(sql)).toBe(idx(prev))
    })
  })

  it("never grants to anon/authenticated", () => {
    expect(sql).not.toMatch(/TO (anon|authenticated)/)
  })
})
