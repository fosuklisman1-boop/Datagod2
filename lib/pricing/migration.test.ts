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

  it("validates inputs with BAD_INPUT before writing", () => {
    expect(sql).toMatch(/v_new\s+numeric;/)
    expect(sql).toMatch(/\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}/)
    expect(sql).toMatch(/package_id must be a uuid/)
    expect(sql).toMatch(/SELECT 1 FROM auth\.users WHERE id = p_admin/)
    expect(sql).toMatch(/unknown admin/)
    expect(sql).toMatch(/package listed twice/)
    expect(sql).toMatch(/conrelid = 'public\.users'::regclass/)
  })

  it("is one transaction", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(sql).toMatch(/^BEGIN;$/m)
    expect(sql).toMatch(/^COMMIT;$/m)
  })
})

describe("0142 place_api_v2_order redefinition", () => {
  const fnOf = (text: string) => {
    const start = text.indexOf("CREATE OR REPLACE FUNCTION public.place_api_v2_order(")
    const endMarker = "TO service_role;"
    const end = text.indexOf(endMarker, start)
    return text.slice(start, end + endMarker.length)
  }
  const sql130 = readFileSync(join(process.cwd(), "migrations", "0130_api_v2_orders.sql"), "utf8")
  const EXISTS_CLAUSE = `
        OR EXISTS (SELECT 1 FROM public.users u
                   JOIN public.user_package_prices upp ON upp.user_id = u.id
                   WHERE u.id = p_user_id AND u.pricing_mode = 'custom'
                     AND upp.package_id = p.id AND upp.price = p_price))`

  it("redefines the function and accepts a custom price", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.place_api_v2_order")
    expect(sql).toMatch(/u\.pricing_mode = 'custom'/)
    expect(sql).toMatch(/upp\.package_id = p\.id AND upp\.price = p_price/)
  })

  it("is identical to 0130 apart from the custom-price clause (no copy drift)", () => {
    const a = fnOf(sql130)
    const b = fnOf(sql)
    expect(b).toContain(EXISTS_CLAUSE)
    const restored = b
      .replace(EXISTS_CLAUSE, ")")
    expect(restored).toBe(a)
  })

  it("keeps exactly one transaction", () => {
    expect(sql.match(/^BEGIN;/gm)).toHaveLength(1)
    expect(sql.match(/^COMMIT;/gm)).toHaveLength(1)
  })
})
