import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("migration 20261017_order_confirmation_billing.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261017_order_confirmation_billing.sql"), "utf8")

  it("runs in a transaction with a lock timeout", () => {
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s'/)
    expect(sql).toMatch(/^COMMIT;/m)
  })

  it("adds the toggle column defaulting to false", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS order_confirmation_use_own_sender BOOLEAN NOT NULL DEFAULT false/)
  })

  it("guard table keys on a UUID order id (matches shop_orders.id) with a mode CHECK", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sms_order_confirmations/)
    expect(sql).toMatch(/shop_order_id UUID PRIMARY KEY/)
    expect(sql).toMatch(/mode TEXT NOT NULL CHECK \(mode IN \('billed', 'free'\)\)/)
    expect(sql).toMatch(/send_log_id BIGINT/)
  })

  it("is service-role only: RLS on, no policies, revoked from public roles", () => {
    expect(sql).toMatch(/ALTER TABLE sms_order_confirmations ENABLE ROW LEVEL SECURITY/)
    expect(sql).not.toMatch(/CREATE POLICY/i)
    expect(sql).toMatch(/REVOKE ALL ON TABLE sms_order_confirmations FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT[^;]*ON TABLE sms_order_confirmations TO service_role/)
  })
})
