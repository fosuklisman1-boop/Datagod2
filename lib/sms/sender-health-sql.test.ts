import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("migration 20261023_sms_sender_health.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261023_sms_sender_health.sql"), "utf8")
  const fn = sql.match(/CREATE OR REPLACE FUNCTION sms_sender_health\(p_hours int\)[\s\S]*?\n\$\$;/)![0]

  it("is wrapped in a transaction with a lock timeout", () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/^COMMIT;\s*$/m)
  })

  it("is a read-only STABLE SECURITY DEFINER jsonb function with a pinned search_path", () => {
    expect(fn).toMatch(/RETURNS jsonb/)
    expect(fn).toMatch(/STABLE/)
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = public/)
    expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
  })

  it("filters with the exact predicate of idx_sms_messages_hubtel_sent (provider/status/processed_at)", () => {
    expect(fn).toMatch(/m\.provider = 'hubtel'/)
    expect(fn).toMatch(/m\.status = 'sent'/)
    expect(fn).toMatch(/m\.processed_at >= now\(\) - make_interval\(hours => /)
    // Moolre (or any non-Hubtel provider) never reports delivery — must not appear.
    expect(fn).not.toMatch(/moolre/i)
  })

  it("groups by sender name with the platform-default label and computes the outcome counts", () => {
    expect(fn).toMatch(/COALESCE\(m\.sender_id, '\(platform default\)'\)/)
    expect(fn).toMatch(/delivery_status = 'delivered'/)
    expect(fn).toMatch(/delivery_status = 'failed'/)
    expect(fn).toMatch(/delivery_status = 'pending'/)
    expect(fn).toMatch(/NULLIF\(/)
    expect(fn).toMatch(/max\(m\.delivered_at\)/)
    expect(fn).toMatch(/max\(m\.processed_at\)/)
    expect(fn).toMatch(/count\(DISTINCT m\.sms_account_id\)/)
    for (const k of ["sender", "total", "delivered", "failed", "in_flight", "delivery_rate", "last_delivered_at", "last_sent_at", "accounts", "registry_status", "is_pool", "kyc_free"]) {
      expect(fn).toContain(`'${k}'`)
    }
  })

  it("prefers an active registry row, else the latest, and aggregates pool/kyc flags", () => {
    expect(fn).toMatch(/FROM sms_sender_ids/)
    expect(fn).toMatch(/ORDER BY \(s\.local_status = 'active'\) DESC, s\.updated_at DESC/)
    expect(fn).toMatch(/bool_or\(s\.is_pool\)/)
    expect(fn).toMatch(/bool_or\(s\.kyc_free\)/)
  })

  it("orders by total desc and caps at 100", () => {
    expect(fn).toMatch(/ORDER BY count\(\*\) DESC/)
    expect(fn).toMatch(/LIMIT 100/)
  })

  it("revokes from public roles and grants service_role only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION sms_sender_health\(int\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT\s+EXECUTE ON FUNCTION sms_sender_health\(int\) TO service_role;/)
    expect(sql).not.toMatch(/TO (anon|authenticated)/)
  })
})
