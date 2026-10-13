import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("migration 20261025_user_nav_clicks.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20261025_user_nav_clicks.sql"), "utf8")

  it("runs in one transaction with a lock timeout", () => {
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/^COMMIT;/m)
  })

  it("creates the table with FK cascade, href length check, clicks 0..2, composite PK", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_nav_clicks/)
    expect(sql).toMatch(/user_id\s+UUID\s+NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/CHECK \(char_length\(href\) BETWEEN 1 AND 200\)/)
    expect(sql).toMatch(/CHECK \(clicks BETWEEN 0 AND 2\)/)
    expect(sql).toMatch(/PRIMARY KEY \(user_id, href\)/)
  })

  it("is service-role only: RLS on, no policies, revoked from public roles", () => {
    expect(sql).toMatch(/ALTER TABLE user_nav_clicks ENABLE ROW LEVEL SECURITY/)
    expect(sql).not.toMatch(/CREATE POLICY/i)
    expect(sql).toMatch(/REVOKE ALL ON TABLE user_nav_clicks FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE user_nav_clicks TO service_role;/)
    expect(sql).not.toMatch(/GRANT[^;]*TO (anon|authenticated)/i)
  })

  it("nav_click is an atomic capped upsert, SECURITY DEFINER, pinned search_path, service-role only", () => {
    const fn = sql.match(/CREATE OR REPLACE FUNCTION nav_click\(p_user_id UUID, p_href TEXT\)[\s\S]*?\$\$;/)![0]
    expect(fn).toMatch(/RETURNS INT/)
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = public/)
    expect(fn).toMatch(/ON CONFLICT \(user_id, href\) DO UPDATE/)
    expect(fn).toMatch(/LEAST\(2, u\.clicks \+ 1\)/)
    expect(fn).toMatch(/RETURNING u\.clicks/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION nav_click\(UUID, TEXT\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION nav_click\(UUID, TEXT\) TO service_role;/)
  })
})
