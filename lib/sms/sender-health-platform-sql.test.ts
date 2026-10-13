import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "..", "migrations", f), "utf8")

describe("migration 20261024_sms_logs_sender_id.sql (static contract)", () => {
  const sql = read("20261024_sms_logs_sender_id.sql")
  const fn = sql.match(/CREATE OR REPLACE FUNCTION sms_sender_health\(p_hours int\)[\s\S]*?\n\$\$;/)![0]
  // Just the platform (sms_logs) arm.
  const platform = fn.slice(fn.indexOf("platform AS ("), fn.indexOf("combined AS ("))

  it("is a transaction with a lock timeout", () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/^COMMIT;\s*$/m)
  })

  it("adds a nullable sender_id with no default (metadata-only on ~137k rows) and no index", () => {
    expect(sql).toMatch(/ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS sender_id TEXT;/)
    expect(sql).not.toMatch(/sender_id TEXT\s+(NOT NULL|DEFAULT)/i)
    expect(sql).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i)
  })

  it("keeps the function read-only, SECURITY DEFINER, pinned search_path, service_role only", () => {
    expect(fn).toMatch(/RETURNS jsonb/)
    expect(fn).toMatch(/STABLE SECURITY DEFINER SET search_path = public/)
    expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION sms_sender_health\(int\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT\s+EXECUTE ON FUNCTION sms_sender_health\(int\) TO service_role;/)
  })

  it("campaign arm is unchanged from 20261023 (same index-friendly predicate, registry join) and tagged 'campaign'", () => {
    expect(fn).toMatch(/m\.provider = 'hubtel'\s+AND m\.status = 'sent'\s+AND m\.processed_at >= now\(\) - make_interval\(hours => /)
    expect(fn).toMatch(/COALESCE\(m\.sender_id, '\(platform default\)'\)/)
    expect(fn).toMatch(/ORDER BY \(s\.local_status = 'active'\) DESC, s\.updated_at DESC/)
    expect(fn).toMatch(/'campaign'/)
  })

  it("platform arm reads sms_logs: hubtel, sender recorded, not shop_sms, accepted by Hubtel, UTC wall-clock window", () => {
    expect(platform).toMatch(/l\.provider = 'hubtel'/)
    expect(platform).toMatch(/l\.sender_id IS NOT NULL/)
    expect(platform).toMatch(/l\.message_type IS DISTINCT FROM 'shop_sms'/)
    expect(platform).toMatch(/l\.moolre_message_id IS NOT NULL/)
    expect(platform).toMatch(/l\.created_at >= \(now\(\) AT TIME ZONE 'UTC'\) - make_interval\(hours => /)
    expect(fn).toMatch(/'platform'/)
  })

  it("maps sms_logs statuses: delivered -> delivered, failed -> failed, sent -> in_flight", () => {
    expect(platform).toMatch(/FILTER \(WHERE l\.status = 'delivered'\)/)
    expect(platform).toMatch(/FILTER \(WHERE l\.status = 'failed'\)/)
    expect(platform).toMatch(/FILTER \(WHERE l\.status = 'sent'\)/)
  })

  it("converts sms_logs timestamps (UTC wall clock) to timestamptz", () => {
    expect(platform).toMatch(/max\(l\.delivered_at\) AT TIME ZONE 'UTC'/)
    expect(platform).toMatch(/max\(l\.created_at\) AT TIME ZONE 'UTC'/)
  })

  it("every output object has the full key set including source; overall limit 100 by total desc", () => {
    for (const k of ["sender", "source", "total", "delivered", "failed", "in_flight", "delivery_rate", "last_delivered_at", "last_sent_at", "accounts", "registry_status", "is_pool", "kyc_free"]) {
      expect(fn).toContain(`'${k}'`)
    }
    expect(fn).toMatch(/LIMIT 100/)
    expect(fn).toMatch(/ORDER BY a\.total DESC/)
  })
})
