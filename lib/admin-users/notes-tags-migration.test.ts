// lib/admin-users/notes-tags-migration.test.ts
//
// Structural checks of 0174_admin_user_notes_tags.sql and 0175_admin_user_signals_indexes.sql. Behaviour
// (constraints, RLS, cascades, every signal count and window) is tested against a real Postgres by
// migrations/tests/0174_admin_user_notes_tags_local_test.sql.
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { RISK_THRESHOLDS } from "./risk-signals"
import { SUGGESTED_TAGS, TAG_RE } from "./notes-tags"

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8")
const sql = read("migrations", "0174_admin_user_notes_tags.sql")
const idx = read("migrations", "0175_admin_user_signals_indexes.sql")
const localTest = read("migrations", "tests", "0174_admin_user_notes_tags_local_test.sql")
const code = (s: string) => s.replace(/--.*$/gm, "")

describe("0174_admin_user_notes_tags.sql structure", () => {
  it("is the only migration numbered 0174 / 0175", () => {
    const files = readdirSync(join(process.cwd(), "migrations"))
    expect(files.filter((f) => f.startsWith("0174_") && f.endsWith(".sql"))).toEqual(["0174_admin_user_notes_tags.sql"])
    expect(files.filter((f) => f.startsWith("0175_") && f.endsWith(".sql"))).toEqual(["0175_admin_user_signals_indexes.sql"])
  })

  it("is one transaction, comment header first, idempotent and additive", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    const c = code(sql)
    expect(c).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE\s+\w+\s+SET|ALTER TABLE\s+\S+\s+(ADD|DROP|ALTER))\b/i)
    for (const m of c.matchAll(/CREATE (TABLE|INDEX)\s+(\S+)/g)) expect(m[2], m[0]).toBe("IF")
    expect(c).not.toMatch(/\bCREATE FUNCTION\b/)
  })

  it("creates the notes and tags tables with the agreed columns and checks", () => {
    const c = code(sql)
    expect(c).toMatch(/CREATE TABLE IF NOT EXISTS public\.admin_user_notes \(/)
    expect(c).toMatch(/user_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/)
    expect(c).toMatch(/author_id\s+uuid\s+REFERENCES auth\.users\(id\) ON DELETE SET NULL/)
    expect(c).toMatch(/body\s+text\s+NOT NULL CHECK \(char_length\(body\) BETWEEN 1 AND 2000\)/)
    expect(c).toMatch(/CREATE TABLE IF NOT EXISTS public\.admin_user_tags \(/)
    expect(c).toMatch(/tag\s+text\s+NOT NULL CHECK \(tag ~ '\^\[a-z0-9-\]\{1,32\}\$'\)/)
    expect(c).toMatch(/PRIMARY KEY \(user_id, tag\)/)
    // the app's tag rule is the same pattern
    expect(TAG_RE.source).toBe("^[a-z0-9-]{1,32}$")
    for (const t of SUGGESTED_TAGS) expect(TAG_RE.test(t), t).toBe(true)
  })

  it("indexes user_id (notes) and tag (tags; the primary key leads with user_id)", () => {
    const c = code(sql)
    expect(c).toMatch(/CREATE INDEX IF NOT EXISTS idx_admin_user_notes_user ON public\.admin_user_notes \(user_id, created_at DESC\)/)
    expect(c).toMatch(/CREATE INDEX IF NOT EXISTS idx_admin_user_tags_tag ON public\.admin_user_tags \(tag, user_id\)/)
  })

  it("enables RLS with no policies and revokes everything from anon and authenticated", () => {
    const c = code(sql)
    for (const t of ["admin_user_notes", "admin_user_tags"]) {
      expect(c, t).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY;`))
      expect(c, t).toMatch(new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM PUBLIC, anon, authenticated;`))
      expect(c, t).toMatch(new RegExp(`GRANT ALL ON public\\.${t}\\s+TO service_role;`))
    }
    expect(c).not.toMatch(/CREATE POLICY/i)
    expect(c).not.toMatch(/GRANT [^;]*\b(anon|authenticated)\b/)
  })

  it("admin_user_signals: SECURITY DEFINER, pinned search_path, service_role only, capped at 200 ids, no dynamic SQL", () => {
    const c = code(sql)
    const header = c.slice(c.indexOf("CREATE OR REPLACE FUNCTION public.admin_user_signals("), c.indexOf("AS $fn$"))
    expect(header).toMatch(/SECURITY DEFINER/)
    expect(header).toMatch(/SET search_path = public, pg_temp/)
    expect(header).toMatch(/STABLE/)
    expect(c).toMatch(/REVOKE ALL ON FUNCTION public\.admin_user_signals\(uuid\[\], int, int, int\) FROM PUBLIC, anon, authenticated;/)
    expect(c).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_user_signals\(uuid\[\], int, int, int\) TO service_role;/)
    expect(c).toMatch(/cardinality\(v_ids\) > 200/)
    expect(c).not.toMatch(/\bEXECUTE\s+(format|'|v_|\$)/i)
  })

  it("admin_user_signals reads every order table admin_user_orders reads, schema-qualified", () => {
    const c = code(sql)
    const body = c.slice(c.indexOf("AS $fn$"), c.indexOf("$fn$;"))
    for (const t of ["orders", "api_orders", "hubtel_data_orders", "airtime_orders", "hubtel_bill_orders", "results_checker_orders", "afa_orders"]) {
      // once for the last order, once for the failed count
      expect(body.match(new RegExp(`FROM public\\.${t}\\b`, "g")) ?? [], t).toHaveLength(2)
    }
    const tables = [...body.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map((m) => m[1]).filter((t) => !["unnest", "LATERAL", "jsonb_object_keys"].includes(t))
    for (const t of tables) expect(t, t).toMatch(/^(public|auth)\./)
  })

  it("refunds are refund credits by source only (never clawbacks), and AFA also counts cancelled as failed", () => {
    const c = code(sql)
    expect(c).not.toMatch(/LIKE '%refund%'/)
    expect(c).toMatch(/t\.type = 'credit'\s+AND t\.source IN \('airtime_refund', 'standard_bundle_refund', 'results_checker_refund',\s+'results_check_refund', 'order_refund', 'bill_refund'\)/)
    expect(c).toMatch(/lower\(afa\.status\) IN \('failed', 'error', 'cancelled'\)/)
    expect(c.match(/IN \('failed', 'error'\)/g)).toHaveLength(6)
  })

  it("the windows' defaults match the app's thresholds", () => {
    expect(sql).toMatch(new RegExp(`p_failed_hours int DEFAULT ${RISK_THRESHOLDS.failedOrdersWindowHours}\\b`))
    expect(sql).toMatch(new RegExp(`p_refund_hours int DEFAULT ${RISK_THRESHOLDS.refundsWindowHours}\\b`))
    expect(sql).toMatch(new RegExp(`p_credit_hours int DEFAULT ${RISK_THRESHOLDS.adminCreditWindowHours}\\b`))
  })
})

describe("0175_admin_user_signals_indexes.sql", () => {
  it("builds the transactions (user_id, created_at DESC) index concurrently, outside a transaction", () => {
    const c = code(idx)
    expect(c).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/)
    expect(c.match(/CREATE INDEX/g)).toHaveLength(1)
    expect(c).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_created_at\s+ON public\.transactions \(user_id, created_at DESC\);/)
  })
})

describe("local Postgres test", () => {
  it("applies both migrations twice and prints its OK marker", () => {
    expect(localTest.match(/\\i migrations\/0174_admin_user_notes_tags\.sql/g)).toHaveLength(2)
    expect(localTest.match(/\\i migrations\/0175_admin_user_signals_indexes\.sql/g)).toHaveLength(2)
    expect(localTest).toContain("ADMIN_USER_NOTES_TAGS_LOCAL_TEST_OK")
  })
})
