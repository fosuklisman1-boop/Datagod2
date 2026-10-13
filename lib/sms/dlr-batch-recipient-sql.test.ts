import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("migration 20261021_sms_dlr_match_by_batch_recipient.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261021_sms_dlr_match_by_batch_recipient.sql"), "utf8")
  const fn = sql.match(/CREATE OR REPLACE FUNCTION apply_sms_delivery_reports\(p_rows JSONB\)[\s\S]*?\nEND \$\$;/)![0]
  const flat = fn.replace(/\s+/g, " ")

  it("is wrapped in a transaction with a lock timeout", () => {
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/^COMMIT;/m)
  })

  it("keeps the live signature, return columns, SECURITY DEFINER and pinned search_path", () => {
    expect(fn).toMatch(/RETURNS TABLE\(out_message_id UUID, out_send_log_id BIGINT, out_outcome TEXT, out_refunded BOOLEAN\)/)
    expect(fn).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/)
  })

  it("revokes from public roles and grants service_role only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION apply_sms_delivery_reports\(JSONB\)\s+FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT\s+EXECUTE ON FUNCTION apply_sms_delivery_reports\(JSONB\)\s+TO service_role;/)
    expect(sql).not.toMatch(/GRANT[^;]*apply_sms_delivery_reports[^;]*(anon|authenticated|PUBLIC)/)
  })

  it("adds a separate, UNIQUE report-id column and never overwrites provider_message_id", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS provider_dlr_message_id TEXT/)
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_provider_dlr_msg ON sms_messages\(provider_dlr_message_id\) WHERE provider_dlr_message_id IS NOT NULL/,
    )
    expect(fn).not.toMatch(/(\bSET|,)\s*provider_message_id\s*=/)
  })

  it("matches by message id first (send-time id or an already-bound report id), and then never falls back", () => {
    expect(flat).toMatch(/IF EXISTS \(SELECT 1 FROM sms_messages WHERE provider_message_id = v_mid OR provider_dlr_message_id = v_mid\) THEN/)
    const idArm = flat.slice(flat.indexOf("IF EXISTS (SELECT 1 FROM sms_messages WHERE provider_message_id = v_mid"), flat.indexOf("-- 2."))
    expect(idArm).toMatch(/\(provider_message_id = v_mid OR provider_dlr_message_id = v_mid\) AND delivery_status = 'pending' FOR UPDATE/)
    expect(idArm).toMatch(/CONTINUE; END IF;\s*$/)
  })

  it("falls back to (provider_batch_id, last 9 digits of the recipient) only for batch reports with a usable `to`", () => {
    expect(flat).toMatch(/CONTINUE WHEN v_bid IS NULL OR v_to IS NULL;/)
    expect(flat).toMatch(/IF v_to IS NOT NULL AND length\(v_to\) < 9 THEN v_to := NULL; END IF;/)
    expect(flat).toMatch(/provider_batch_id = v_bid/)
    expect(flat).toMatch(/right\(regexp_replace\(phone, '\\D', '', 'g'\), 9\) = right\(v_to, 9\)/)
    expect(flat).toMatch(/provider = 'hubtel' AND status = 'sent' AND delivery_status = 'pending'/)
  })

  it("is one-to-one: a report binds at most one row, a bound row is never re-matched, rows reported by their own id are left alone", () => {
    expect(flat).toMatch(/provider_dlr_message_id IS NULL/)
    expect(flat).toMatch(/id <> ALL \(v_used\)/)
    expect(flat).toMatch(/provider_message_id IS NULL OR provider_message_id <> ALL \(v_mids\)/)
    expect(flat).toMatch(/ORDER BY created_at, id LIMIT 1 FOR UPDATE;/)
    expect(flat).toMatch(/v_used := v_used \|\| v_id;/)
    expect(flat).toMatch(/SET provider_dlr_message_id = v_mid/)
    // Concurrent polls of the same batch are serialized before the existence check.
    expect(flat).toMatch(/IF v_bid IS NOT NULL THEN PERFORM pg_advisory_xact_lock\(hashtextextended\('sms_dlr_batch:' \|\| v_bid, 0\)\); END IF;/)
    expect(flat.indexOf("pg_advisory_xact_lock")).toBeLessThan(flat.indexOf("IF EXISTS (SELECT 1 FROM sms_messages"))
  })

  it("settles only pending rows; non-final states record cost only; failed refunds via refund_sms_message", () => {
    expect(flat.match(/delivery_status = 'pending'/g)!.length).toBeGreaterThanOrEqual(4)
    expect(flat).toMatch(/IF v_state NOT IN \('delivered','failed'\) THEN UPDATE sms_messages SET cost_ghs = COALESCE\(v_rate, cost_ghs\)/)
    expect(flat.match(/CASE WHEN v_state = 'failed' THEN refund_sms_message\((m\.id|v_id)\) ELSE false END/g)).toHaveLength(2)
    expect(flat.match(/delivered_at = CASE WHEN v_state = 'delivered' THEN COALESCE\(v_at, now\(\)\) END/g)).toHaveLength(2)
  })

  it("skips malformed rows instead of raising", () => {
    expect(flat).toMatch(/IF p_rows IS NULL OR jsonb_typeof\(p_rows\) <> 'array' THEN RETURN; END IF;/)
    expect(flat).toMatch(/CONTINUE WHEN jsonb_typeof\(e\) IS DISTINCT FROM 'object';/)
    expect(flat).toMatch(/BEGIN v_at := \(e->>'at'\)::timestamptz; EXCEPTION WHEN others THEN v_at := NULL; END;/)
    expect(fn).not.toMatch(/jsonb_to_recordset/)
    expect(fn).not.toMatch(/RAISE/)
  })
})
