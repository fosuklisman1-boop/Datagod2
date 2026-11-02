// lib/admin-users/migration.test.ts
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const sql = readFileSync(join(process.cwd(), "migrations", "0145_admin_list_users.sql"), "utf8")
const LIST_SIG = "public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int)"

const fnBody = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const end = sql.indexOf("$fn$;", start)
  return sql.slice(start, end)
}

describe("0145_admin_list_users.sql", () => {
  it("is the only migration numbered 0145", () => {
    const same = readdirSync(join(process.cwd(), "migrations")).filter((f) => f.startsWith("0145_") && f.endsWith(".sql"))
    expect(same).toEqual(["0145_admin_list_users.sql"])
  })

  it("is one idempotent transaction with a comment header", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(sql).not.toMatch(/CREATE FUNCTION/)
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/)
    expect(sql).not.toMatch(/ALTER TABLE|DROP /)
  })

  it("defines admin_list_users with the agreed signature, SECURITY DEFINER, pinned search_path, no JIT", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.admin_list_users\(\s*p_search\s+text,\s*p_role\s+text,\s*p_suspended\s+boolean,\s*p_has_shop\s+boolean,\s*p_pricing_mode\s+text,\s*p_created_from\s+timestamptz,\s*p_created_to\s+timestamptz,\s*p_sort\s+text,\s*p_dir\s+text,\s*p_limit\s+int,\s*p_offset\s+int\s*\)\s*RETURNS jsonb/,
    )
    const body = fnBody("admin_list_users")
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = public\s+SET jit = off/)
    expect(body).toMatch(/jsonb_build_object\(\s*'total', \(SELECT count\(\*\) FROM base\)/)
  })

  it("is service_role only", () => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${LIST_SIG}\n  FROM PUBLIC, anon, authenticated;`)
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${LIST_SIG}\n  TO service_role;`)
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.admin_user_stats(uuid) FROM PUBLIC, anon, authenticated;")
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.admin_user_stats(uuid) TO service_role;")
  })

  it("whitelists sorts and dirs, clamps limit 1..200 and offset >= 0", () => {
    const body = fnBody("admin_list_users")
    expect(body).toContain("IF v_sort NOT IN ('created_at', 'balance', 'email', 'shop_balance', 'last_sign_in_at') THEN")
    expect(body).toContain("IF v_dir NOT IN ('asc', 'desc') THEN")
    expect(body).toContain("least(greatest(coalesce(p_limit, 50), 1), 200)")
    expect(body).toContain("greatest(coalesce(p_offset, 0), 0)")
    // stable tiebreaker on id, both directions
    expect(body).toMatch(/CASE WHEN v_asc\s+THEN b\.id END ASC,\s*CASE WHEN NOT v_asc THEN b\.id END DESC/)
    // no dynamic SQL anywhere
    expect(sql).not.toMatch(/EXECUTE\s+(format|'|v_)/)
  })

  it("escapes LIKE wildcards (backslash first) and searches email, phone and shop name case-insensitively", () => {
    const body = fnBody("admin_list_users")
    expect(body).toContain(`replace(replace(replace(v_term, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`)
    expect(body).toMatch(/au\.email ILIKE v_like/)
    expect(body).toMatch(/u\.phone_number ILIKE v_like/)
    expect(body).toMatch(/sh\.shop_name ILIKE v_like/)
    expect(body).toContain("left(nullif(btrim(coalesce(p_search, '')), ''), 100)")
  })

  it("normalises Ghana phone prefixes (0 / 233) on both sides", () => {
    const body = fnBody("admin_list_users")
    expect(body).toContain("IF v_digits LIKE '233%' AND length(v_digits) > 3 THEN")
    expect(body).toContain("ELSIF v_digits LIKE '0%' THEN")
    expect(body).toContain("'^(233|0)', '') LIKE v_digits || '%'")
  })

  it("reproduces the old route's joins and defaults", () => {
    const body = fnBody("admin_list_users")
    expect(body).toContain("FROM auth.users au")
    expect(body).toContain("coalesce(u.role, 'user')")
    expect(body).toContain("coalesce(u.is_suspended, false)")
    expect(body).toContain("coalesce(u.pricing_mode, 'role')")
    expect(body).toContain("CASE WHEN sh.id IS NULL THEN 0 ELSE coalesce(sab.available_balance, 0) END AS shop_balance")
    expect(body).toContain("FROM public.shop_customers c WHERE c.shop_id = p.shop_id")
    expect(body).toContain("FROM public.user_shops sa WHERE sa.parent_shop_id = p.shop_id")
    expect(body).not.toMatch(/INSERT|UPDATE|DELETE/)
  })

  it("admin_user_stats keeps the get_user_financial_summary formulas", () => {
    const body = fnBody("admin_user_stats")
    expect(body).toContain("t.type = 'credit' AND t.source = 'wallet_topup' AND t.status = 'completed'")
    expect(body).toContain("t.type = 'debit' AND t.status IN ('completed', 'success') THEN abs(t.amount)")
    expect(body).toContain("o.status IN ('completed', 'delivered', 'success')")
    expect(body).toContain("o.payment_status = 'completed'")
    expect(body).toContain("o.order_status IN ('completed', 'delivered')")
    expect(body).toContain("sum(o.total_price) FILTER (WHERE o.payment_status = 'completed')")
    expect(body).toContain("wr.status IN ('completed', 'approved') THEN wr.net_amount")
    expect(body).toMatch(/ORDER BY wr\.created_at DESC\s+LIMIT 10/)
    for (const key of ["userId", "wallet", "orders", "shop", "withdrawals", "totalTopUps", "totalSpent", "transactionCount",
      "paidOrders", "completedOrders", "totalSales", "availableBalance", "withdrawnAmount", "totalProfit", "pendingProfit",
      "creditedProfit", "profitRecords", "totalWithdrawn", "pendingCount", "completedCount", "history"]) {
      expect(body).toContain(`'${key}'`)
    }
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = public/)
  })

  it("has a local Postgres test", () => {
    const t = readFileSync(join(process.cwd(), "migrations", "tests", "0145_admin_list_users_local_test.sql"), "utf8")
    expect(t).toContain("\\i migrations/0145_admin_list_users.sql")
    expect(t).toContain("ADMIN_LIST_USERS_LOCAL_TEST_OK")
  })
})
