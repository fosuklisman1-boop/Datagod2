import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("migration 20261016_sms_scheduled_sends.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261016_sms_scheduled_sends.sql"), "utf8")

  it("adds scheduled_for and source with a CHECK and a partial due index", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ/)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'campaign'/)
    expect(sql).toMatch(/sms_send_logs_source_check CHECK \(source IN \('campaign', 'order_confirmation'\)\)/)
    expect(sql).toMatch(/idx_sms_send_logs_due[\s\S]*?WHERE status = 'scheduled'/)
  })

  it("does not grant the new columns to authenticated", () => {
    expect(sql).not.toMatch(/GRANT\s+SELECT[^;]*scheduled_for/i)
  })

  it("promote is an atomic SKIP LOCKED gate, SECURITY DEFINER, pinned search_path", () => {
    const fn = sql.match(/CREATE OR REPLACE FUNCTION sms_promote_due_scheduled\(p_limit INT\)[\s\S]*?\$\$;/)![0]
    expect(fn).toMatch(/RETURNS TABLE\(out_id BIGINT, out_account_id UUID, out_sender_id TEXT\)/)
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = public/)
    expect(fn).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(fn).toMatch(/status = 'scheduled' AND s\.scheduled_for <= now\(\)/)
    expect(fn).toMatch(/SET status = 'queued'/)
  })

  it("cancel is locked, idempotent, refunds in one ledger row", () => {
    const fn = sql.match(/CREATE OR REPLACE FUNCTION cancel_scheduled_sms_campaign\([\s\S]*?\n\$\$;/)![0]
    expect(fn).toMatch(/p_send_log_id BIGINT/)
    expect(fn).toMatch(/p_account_id UUID DEFAULT NULL/)
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = public/)
    expect(fn).toMatch(/FROM sms_send_logs WHERE id = p_send_log_id FOR UPDATE/)
    expect(fn).toMatch(/'sched_cancel:'/)
    expect(fn).toMatch(/'campaign_refund'/)
    expect(fn).toMatch(/scheduled_cancelled/)
    expect(fn).toMatch(/'already_cancelled'/)
    expect(fn).toMatch(/'not_scheduled'/)
    expect(fn).toMatch(/'cancelled'/)
    expect(fn).toMatch(/NOT EXISTS \(SELECT 1 FROM sms_unit_transactions WHERE ref = v_ref\)/)
    expect(fn).toMatch(/credits_used = 0/)
  })

  it("revokes from public roles and grants service_role only on both new functions", () => {
    for (const sig of ["sms_promote_due_scheduled\\(INT\\)", "cancel_scheduled_sms_campaign\\(BIGINT, UUID, TEXT\\)"]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`GRANT\\s+EXECUTE ON FUNCTION ${sig} TO service_role`))
    }
  })

  it("sms_account_usage excludes cancelled and otherwise matches 20261015", () => {
    expect(sql).toMatch(/IN \('rejected', 'cancelled'\)/)
    const prev = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261015_sms_usage_exclude_rejected.sql"), "utf8")
    const body = (s: string) => s.match(/\$\$[\s\S]*?\$\$;/)![0].replace(/\s+/g, " ").replace("= 'rejected'", "IN ('rejected', 'cancelled')")
    expect(body(sql.slice(sql.indexOf("FUNCTION sms_account_usage")))).toBe(body(prev))
  })
})
