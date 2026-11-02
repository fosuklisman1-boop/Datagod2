// lib/admin-users/migration.test.ts
//
// Structural checks only. Behaviour (filters, search escaping, sorts, keyset paging,
// stats numbers) is tested against a real Postgres by
// migrations/tests/0145_admin_list_users_local_test.sql.
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8")
const sql = read("migrations", "0145_admin_list_users.sql")
const localTest = read("migrations", "tests", "0145_admin_list_users_local_test.sql")

/** Every function the migration defines: name -> { header (up to AS $fn$), body }. */
function functions(text: string) {
  const out = new Map<string, { header: string; body: string; args: string }>()
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS[\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/g
  for (const m of text.matchAll(re)) {
    const start = m.index!
    const header = text.slice(start, text.indexOf("AS $fn$", start))
    out.set(m[1], { header, body: m[3], args: m[2] })
  }
  return out
}
const fns = functions(sql)
const PUBLIC_RPCS = ["admin_list_users", "admin_export_users", "admin_user_stats"]
const HELPERS = ["admin_users_search_terms", "admin_users_filtered"]

describe("0145_admin_list_users.sql structure", () => {
  it("is the only migration numbered 0145", () => {
    const same = readdirSync(join(process.cwd(), "migrations")).filter((f) => f.startsWith("0145_") && f.endsWith(".sql"))
    expect(same).toEqual(["0145_admin_list_users.sql"])
  })

  it("is one transaction, comment header first, additive only", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    const code = sql.replace(/--.*$/gm, "")
    // The only DROPs remove the draft signatures without p_tag (see the header), nothing else.
    const drops = code.match(/^DROP .*$/gm) ?? []
    expect(drops).toEqual([
      "DROP FUNCTION IF EXISTS public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int);",
      "DROP FUNCTION IF EXISTS public.admin_export_users(text, text, boolean, boolean, text, timestamptz, timestamptz, timestamptz, uuid, int);",
    ])
    const rest = code.replace(/^DROP FUNCTION IF EXISTS .*$/gm, "")
    expect(rest).not.toMatch(/\b(ALTER TABLE|DROP|TRUNCATE|CREATE (UNIQUE )?INDEX|CREATE TABLE)\b/i)
    expect(code).not.toMatch(/\bCREATE FUNCTION\b/) // re-runnable: CREATE OR REPLACE only
  })

  it("list and export take a trailing p_tag DEFAULT NULL, validate it, filter on it and return each row's tags", () => {
    for (const name of ["admin_list_users", "admin_export_users"]) {
      const f = fns.get(name)!
      expect(f.args.trim(), name).toMatch(/p_tag\s+text DEFAULT NULL$/)
      expect(f.body, name).toMatch(/v_tag !~ '\^\[a-z0-9-\]\{1,32\}\$'/)
      expect(f.body, name).toMatch(/v_tag IS NULL\s+OR EXISTS \(SELECT 1 FROM public\.admin_user_tags tg WHERE tg\.user_id = f\.id AND tg\.tag = v_tag\)/)
      expect(f.body, name).toMatch(/'tags',\s+coalesce\(\(SELECT jsonb_agg\(tg\.tag ORDER BY tg\.tag\) FROM public\.admin_user_tags tg/)
    }
    // the inlinable helper stays free of the tags table (it only exists after 0149)
    expect(fns.get("admin_users_filtered")!.body).not.toMatch(/admin_user_tags/)
  })

  it("defines exactly the expected functions", () => {
    expect([...fns.keys()].sort()).toEqual([...PUBLIC_RPCS, ...HELPERS].sort())
  })

  it("public RPCs are SECURITY DEFINER with search_path = public, pg_temp", () => {
    for (const name of PUBLIC_RPCS) {
      const { header } = fns.get(name)!
      expect(header, name).toMatch(/SECURITY DEFINER/)
      expect(header, name).toMatch(/SET search_path = public, pg_temp/)
    }
  })

  it("the filter helper is a plain SQL function (inlinable: no SECURITY DEFINER, no SET) and schema-qualifies every table", () => {
    const { header, body } = fns.get("admin_users_filtered")!
    expect(header).toMatch(/LANGUAGE sql/)
    expect(header).not.toMatch(/SECURITY DEFINER|\bSET\b/)
    const tables = [...body.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map((m) => m[1]).filter((t) => t !== "LATERAL")
    expect(tables.length).toBeGreaterThan(0)
    for (const t of tables) expect(t, t).toMatch(/^(public|auth)\./)
  })

  it("every function is revoked from PUBLIC, anon and authenticated; only the RPCs are granted to service_role", () => {
    const code = sql.replace(/--.*$/gm, "")
    for (const name of [...PUBLIC_RPCS, ...HELPERS]) {
      expect(code, name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`))
    }
    for (const name of PUBLIC_RPCS) {
      expect(code, name).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s+TO service_role;`))
    }
    for (const name of HELPERS) {
      expect(code, name).not.toMatch(new RegExp(`GRANT [^;]*public\\.${name}\\(`))
    }
  })

  it("never builds SQL dynamically", () => {
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\bEXECUTE\s+(format|'|v_|\$)/i)
  })

  it("list and export share one filter definition", () => {
    for (const name of ["admin_list_users", "admin_export_users"]) {
      expect(fns.get(name)!.body, name).toMatch(/FROM public\.admin_users_filtered\(/)
      expect(fns.get(name)!.body, name).toMatch(/FROM public\.admin_users_search_terms\(p_search\)/)
    }
    // the filters themselves live only in the helper
    for (const name of PUBLIC_RPCS) expect(fns.get(name)!.body, name).not.toMatch(/ILIKE/)
  })

  it("export keyset-paginates on (created_at, id) in chunks of at most 5000", () => {
    const helper = fns.get("admin_users_filtered")!.body
    expect(helper).toMatch(/\(coalesce\(au\.created_at, '-infinity'::timestamptz\), au\.id\) > \(p_after_created_at, p_after_id\)/)
    const exp = fns.get("admin_export_users")!.body
    expect(exp).toMatch(/ORDER BY f\.created_key, f\.id/)
    expect(exp).toMatch(/least\(greatest\(coalesce\(p_limit, 5000\), 1\), 5000\)/)
  })

  it("role defaults treat '' as 'user'", () => {
    const code = sql.replace(/--.*$/gm, "")
    expect(code).not.toMatch(/coalesce\(u\.role, 'user'\)/)
    expect(code).toMatch(/coalesce\(nullif\(u\.role, ''\), 'user'\)/)
  })

  it("joins shop_available_balance directly (shop_id is unique)", () => {
    const helper = fns.get("admin_users_filtered")!.body
    expect(helper).toMatch(/LEFT JOIN public\.shop_available_balance \w+\s+ON \w+\.shop_id = sh\.id/)
    expect(helper).not.toMatch(/LATERAL/)
  })
})

describe("local Postgres test", () => {
  it("applies the migration and prints its OK marker", () => {
    expect(localTest).toContain("\\i migrations/0145_admin_list_users.sql")
    expect(localTest).toContain("ADMIN_LIST_USERS_LOCAL_TEST_OK")
  })

  it("carries an exact copy of get_user_financial_summary from optimize_admin_stats.sql (no copy drift)", () => {
    const begin = "-- BEGIN COPY: migrations/optimize_admin_stats.sql get_user_financial_summary\n"
    const end = "-- END COPY\n"
    const copy = localTest.slice(localTest.indexOf(begin) + begin.length, localTest.indexOf(end))
    expect(localTest.indexOf(begin)).toBeGreaterThan(-1)
    const src = read("migrations", "optimize_admin_stats.sql")
    const start = src.indexOf("CREATE OR REPLACE FUNCTION get_user_financial_summary(")
    const stop = src.indexOf("$$ LANGUAGE plpgsql SECURITY DEFINER;", start) + "$$ LANGUAGE plpgsql SECURITY DEFINER;".length
    expect(start).toBeGreaterThan(-1)
    expect(copy.trim()).toBe(src.slice(start, stop).trim())
  })
})
