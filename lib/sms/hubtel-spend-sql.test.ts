import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("migration 20261020_sms_hubtel_spend_since.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261020_sms_hubtel_spend_since.sql"), "utf8")
  const fn = sql.match(/CREATE OR REPLACE FUNCTION sms_hubtel_spend_since\([\s\S]*?\$\$;/)![0]
  const body = fn.replace(/\s+/g, " ")
  const messagesArm = body.match(/SELECT[^;]*INTO v_messages[^;]*;/)![0]
  const logsArm = body.match(/SELECT[^;]*INTO v_logs[^;]*;/)![0]

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

  it("adds the partial covering index for the sms_messages arm", () => {
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_sms_messages_hubtel_sent ON sms_messages \(processed_at\) INCLUDE \(segments, cost_ghs\) WHERE provider = 'hubtel' AND status = 'sent';/)
  })

  describe("sms_messages arm", () => {
    it("every Hubtel-accepted row sent at/after p_since (index-friendly predicate)", () => {
      expect(messagesArm).toMatch(/FROM sms_messages m WHERE m\.provider = 'hubtel' AND m\.status = 'sent' AND m\.processed_at >= p_since;/)
    })
    it("does NOT exclude refunded rows (customer refund ≠ Hubtel refund)", () => {
      expect(messagesArm).not.toMatch(/refunded/)
    })
    it("prices segments × the higher of the reported rate and the default rate", () => {
      expect(messagesArm).toMatch(/sum\(m\.segments \* GREATEST\(COALESCE\(m\.cost_ghs, 0\), p_default_rate\)\)/)
      expect(messagesArm).toMatch(/COALESCE\(sum\(/)
    })
  })

  describe("sms_logs arm (sendSMS: OTP / transactional / broadcast)", () => {
    it("counts Hubtel rows logged sent or delivered", () => {
      expect(logsArm).toMatch(/FROM sms_logs l WHERE l\.provider = 'hubtel' AND l\.status IN \('sent', 'delivered'\)/)
    })
    it("excludes the drain's shop_sms (already in sms_messages) but keeps NULL types", () => {
      expect(logsArm).toMatch(/l\.message_type IS DISTINCT FROM 'shop_sms'/)
    })
    it("compares the timestamp-without-time-zone column in UTC", () => {
      expect(logsArm).toMatch(/l\.created_at >= \(p_since AT TIME ZONE 'UTC'\)/)
    })
    it("prices default rate × estimated segments (153 ASCII / 67 non-ASCII, min 1)", () => {
      expect(logsArm).toMatch(/p_default_rate \* GREATEST\(1, ceil\(length\(l\.message\)::numeric \/ CASE WHEN octet_length\(l\.message\) > length\(l\.message\) THEN 67 ELSE 153 END\)\)/)
    })
  })

  it("returns both arms added together", () => {
    expect(body).toMatch(/RETURN v_messages \+ v_logs;/)
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
