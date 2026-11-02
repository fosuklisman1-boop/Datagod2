// Structural checks of the admin user drawer migrations. Behaviour is tested against a real Postgres by
// migrations/tests/0146_admin_wallet_adjust_local_test.sql and migrations/tests/0147_admin_user_orders_local_test.sql.
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8")
const code = (sql: string) => sql.replace(/--.*$/gm, "")

function fn(sql: string, name: string) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([\\s\\S]*?)\\)\\s*RETURNS[\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;`)
  const m = sql.match(re)
  if (!m) throw new Error(`function ${name} not found`)
  const header = sql.slice(m.index!, sql.indexOf("AS $fn$", m.index!))
  return { header, body: m[2] }
}

const MIGRATIONS = {
  "0146": { file: "0146_admin_wallet_adjust.sql", test: "0146_admin_wallet_adjust_local_test.sql", rpcs: ["admin_wallet_adjust"], helpers: [] as string[] },
  "0147": { file: "0147_admin_user_orders.sql", test: "0147_admin_user_orders_local_test.sql", rpcs: ["admin_user_orders"], helpers: ["admin_user_orders_union"] },
}

describe.each(Object.entries(MIGRATIONS))("migration %s", (num, m) => {
  const sql = read("migrations", m.file)

  it("is the only migration with its number and has a local Postgres test", () => {
    const same = readdirSync(join(process.cwd(), "migrations")).filter((f) => f.startsWith(`${num}_`) && f.endsWith(".sql"))
    expect(same).toEqual([m.file])
    const t = read("migrations", "tests", m.test)
    expect(t).toMatch(new RegExp(`\\\\i migrations/${m.file}`))
    expect(t).toMatch(/LOCAL ONLY/)
  })

  it("is one transaction, comment header first, additive only", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(code(sql)).not.toMatch(/\b(ALTER TABLE|DROP|TRUNCATE|CREATE (UNIQUE )?INDEX|CREATE TABLE)\b/i)
    expect(code(sql)).not.toMatch(/\bCREATE FUNCTION\b/)
  })

  it("RPCs are SECURITY DEFINER, pin search_path, and only service_role may execute them", () => {
    for (const name of m.rpcs) {
      const { header } = fn(sql, name)
      expect(header, name).toMatch(/SECURITY DEFINER/)
      expect(header, name).toMatch(/SET search_path = public, pg_temp/)
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`))
    }
    expect(code(sql)).not.toMatch(/GRANT [^;]* TO (anon|authenticated|PUBLIC)/i)
  })

  it("helpers are revoked from everyone and never SECURITY DEFINER", () => {
    for (const name of m.helpers) {
      const { header } = fn(sql, name)
      expect(header).not.toMatch(/SECURITY DEFINER|\bSET\b/)
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
      expect(code(sql)).not.toMatch(new RegExp(`GRANT [^;]*${name}`))
    }
  })

  it("schema-qualifies every table it reads or writes", () => {
    for (const name of [...m.rpcs, ...m.helpers]) {
      const { body } = fn(sql, name)
      const tables = [...body.matchAll(/\b(?:FROM|JOIN|UPDATE|INSERT INTO)\s+([a-z_][a-z_.]*)/gi)].map((x) => x[1])
        .filter((t) => !["LATERAL", "jsonb_array_elements"].includes(t))
      for (const t of tables) expect(t, `${name}: ${t}`).toMatch(/^(public\.|pg_temp\.)/)
    }
  })
})

describe("0146 admin_wallet_adjust", () => {
  const sql = read("migrations", "0146_admin_wallet_adjust.sql")
  const { body, header } = fn(sql, "admin_wallet_adjust")

  it("locks the wallet row before reading the balance and refuses ambiguous or missing wallets", () => {
    const lock = body.indexOf("FOR UPDATE")
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(body.indexOf("SELECT coalesce(w.balance, 0) INTO v_before"))
    expect(body).toMatch(/WALLET_NOT_FOUND/)
    expect(body).toMatch(/AMBIGUOUS_WALLET/)
  })

  it("refuses an overdraft instead of clamping it, and checks the confirmed balance", () => {
    expect(body).toMatch(/IF v_after < 0 THEN\s+RAISE EXCEPTION 'INSUFFICIENT_BALANCE'/)
    expect(body).not.toMatch(/greatest\(0/i)
    expect(body).toMatch(/BALANCE_CHANGED/)
  })

  it("validates amount (> 0, 2 decimals, cap), reason (5..500), type and the acting admin", () => {
    expect(body).toMatch(/p_amount <= 0/)
    expect(body).toMatch(/p_amount <> round\(p_amount, 2\)/)
    expect(body).toMatch(/p_amount > 50000/)
    expect(body).toMatch(/char_length\(v_reason\) < 5 OR char_length\(v_reason\) > 500/)
    expect(body).toMatch(/p_type NOT IN \('credit', 'debit'\)/)
    expect(body).toMatch(/u\.role = 'admin'/)
  })

  it("writes the wallet, a transactions row with the existing admin types, and an audit row", () => {
    expect(body).toMatch(/UPDATE public\.wallets/)
    expect(body).toMatch(/INSERT INTO public\.transactions/)
    expect(body).toMatch(/'admin_' \|\| p_type/)
    expect(body).toMatch(/'admin_operation'/)
    expect(body).toMatch(/balance_before, balance_after/)
    expect(body).toMatch(/INSERT INTO public\.admin_audit_log \(admin_id, action, target_user_id, old_value, new_value\)/)
    expect(body).toMatch(/'wallet_' \|\| p_type/)
    expect(body).toMatch(/'reason', v_reason/)
    expect(header).toMatch(/VOLATILE/)
  })
})

describe("0147 admin_user_orders", () => {
  const sql = read("migrations", "0147_admin_user_orders.sql")

  it("unions exactly the user-owned order tables, each filtered on user_id", () => {
    const { body } = fn(sql, "admin_user_orders_union")
    const tables = [...body.matchAll(/FROM (public\.\w+) (\w+)\s+WHERE (\w+)\.user_id = p_user_id/g)].map((x) => {
      expect(x[2], x[1]).toBe(x[3])
      return x[1]
    })
    expect(tables.sort()).toEqual([
      "public.afa_orders", "public.airtime_orders", "public.api_orders", "public.hubtel_bill_orders",
      "public.hubtel_data_orders", "public.orders", "public.results_checker_orders",
    ])
    expect(body.match(/UNION ALL/g)).toHaveLength(6)
  })

  it("pages in SQL, newest first, with a clamped limit", () => {
    const { body } = fn(sql, "admin_user_orders")
    expect(body).toMatch(/ORDER BY u\.created_at DESC NULLS LAST, u\.id DESC\s+LIMIT v_limit OFFSET v_offset/)
    expect(body).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 100\)/)
    expect(body).toMatch(/count\(\*\)/)
  })

  it("its source list matches the route's", async () => {
    const { ORDER_SOURCES } = await import("./drawer-params")
    const { body } = fn(sql, "admin_user_orders")
    const list = body.match(/NOT IN \(([^)]*)\)/)![1].split(",").map((s) => s.trim().replace(/'/g, ""))
    expect(list).toEqual([...ORDER_SOURCES])
  })
})
