// lib/pricing/migration.test.ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const sql = readFileSync(join(process.cwd(), "migrations", "0142_user_package_prices.sql"), "utf8")

describe("0142_user_package_prices.sql", () => {
  it("adds users.pricing_mode with a role/custom check, default role", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'role'/)
    expect(sql).toMatch(/CHECK \(pricing_mode IN \('role', 'custom'\)\)/)
  })

  it("creates user_package_prices keyed by (user_id, package_id) with a bounded price", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.user_package_prices/)
    expect(sql).toMatch(/PRIMARY KEY \(user_id, package_id\)/)
    expect(sql).toMatch(/CHECK \(price > 0 AND price <= 10000\)/)
    expect(sql).toMatch(/REFERENCES public\.users\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/REFERENCES public\.packages\(id\) ON DELETE CASCADE/)
  })

  it("enables RLS and lets users read only their own rows", () => {
    expect(sql).toMatch(/ALTER TABLE public\.user_package_prices ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/FOR SELECT\s+USING \(user_id = \(SELECT auth\.uid\(\)\)\)/)
  })

  it("stops users changing their own pricing_mode (extends the 0045 policy)", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_current_user_pricing_mode\(\)/)
    expect(sql).toMatch(/AND role = public\.get_current_user_role\(\)\s+AND pricing_mode = public\.get_current_user_pricing_mode\(\)/)
  })

  it("defines the service-role-only write RPC that audits to admin_audit_log", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.set_user_custom_prices\(\s*p_admin uuid,\s*p_user uuid,\s*p_mode text,\s*p_prices jsonb\s*\)/)
    expect(sql).toMatch(/INSERT INTO public\.admin_audit_log/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.set_user_custom_prices\(uuid, uuid, text, jsonb\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_user_custom_prices\(uuid, uuid, text, jsonb\) TO service_role/)
  })

  it("is one transaction", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(sql).toMatch(/^BEGIN;$/m)
    expect(sql).toMatch(/^COMMIT;$/m)
  })
})
