// lib/api-v1/migration-0163.test.ts
// migrations/0163_api_v1_retirement.sql and its self-test: three retirement columns on api_v2_config.
// Same harness style as lib/momo-claim/migration-0161.test.ts (self-rolling-back run string, PGlite).
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")

const FILE = "0163_api_v1_retirement.sql"
const SELFTEST_FILE = "0163_api_v1_retirement.selftest.sql"
const BASE = "0128_api_v2_foundation.sql"
const migration = () => read(FILE)

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map(l => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0163: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex(l => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0163: run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0163: run string does not end by raising")
  return run
}
const runString = () => buildRunString(migration(), read(SELFTEST_FILE))

describe("0163 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("adds the three columns idempotently and touches nothing else", () => {
    const c = code(migration())
    expect(c).toMatch(/ADD COLUMN IF NOT EXISTS v1_sunset_at\s+timestamptz\b(?!\s+NOT NULL)/i)
    expect(c).toMatch(/ADD COLUMN IF NOT EXISTS v1_exempt_user_ids\s+uuid\[\]\s+NOT NULL\s+DEFAULT '\{\}'/i)
    expect(c).toMatch(/ADD COLUMN IF NOT EXISTS v1_notice_sent_at\s+timestamptz\b/i)
    expect(c).not.toMatch(/\bGRANT\b|\bREVOKE\b|POLICY|DROP\b|DISABLE ROW/i)
    expect(c).toMatch(/notify pgrst, 'reload schema'/i)
  })
})

describe("0163 run string (migration + self-test)", () => {
  it("has no COMMIT and no bare END; statement, and ends with the always-raising DO block", () => {
    const s = code(runString())
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0163[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("the builder refuses a second COMMIT and a self-test that does not raise last", () => {
    const m = migration()
    const st = read(SELFTEST_FILE)
    expect(() => buildRunString(m.replace(/^BEGIN;/m, "BEGIN;\nCOMMIT;"), st)).toThrow(/could commit/)
    expect(() => buildRunString(m, st.replace(/RAISE EXCEPTION 'SELFTEST_OK[^']*';/, ""))).toThrow(/does not end by raising/)
  })
})

// ───────────────────────────────────────── Behaviour, in PGlite ─────────────────────────────────────────

async function loadPGlite(): Promise<any> {
  try {
    const name = "@electric-sql/pglite" // a variable: nothing may resolve this at transform time
    return (await import(/* @vite-ignore */ name)).PGlite
  } catch {
    return null
  }
}
const PGliteCtor = await loadPGlite()

// 0128 is run as committed; it only needs auth.users and the Supabase roles.
const SETUP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
`

describe.skipIf(!PGliteCtor)("0163 in PGlite (on top of 0128)", () => {
  let db: any
  const cols = async () =>
    (await db.query(`SELECT column_name AS c, data_type AS t, is_nullable AS n, column_default AS d
                     FROM information_schema.columns WHERE table_schema='public' AND table_name='api_v2_config' ORDER BY ordinal_position`)).rows

  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(SETUP)
    await db.exec(read(BASE))
  }, 60_000)

  it("the self-rolling-back run string reports SELFTEST_OK and leaves the table as 0128 made it", async () => {
    const before = (await cols()).map((r: any) => r.c)
    expect(before).not.toContain("v1_sunset_at")
    try {
      await expect(db.exec(runString())).rejects.toThrow(/SELFTEST_OK 0163/)
    } finally {
      await db.exec("ROLLBACK")
    }
    expect((await cols()).map((r: any) => r.c)).toEqual(before)
  })

  describe("after apply (twice: idempotent)", () => {
    beforeAll(async () => {
      await db.exec(migration())
      await db.exec(migration())
    })

    it("adds the three columns with the stated types and defaults", async () => {
      const by = Object.fromEntries((await cols()).map((r: any) => [r.c, r]))
      expect(by.v1_sunset_at).toMatchObject({ t: "timestamp with time zone", n: "YES", d: null })
      expect(by.v1_notice_sent_at).toMatchObject({ t: "timestamp with time zone", n: "YES", d: null })
      expect(by.v1_exempt_user_ids).toMatchObject({ t: "ARRAY", n: "NO" })
      expect(String(by.v1_exempt_user_ids.d)).toContain("'{}'")
    })

    it("the existing row is untouched: no sunset, no exemptions, no notice", async () => {
      const r = (await db.query("SELECT * FROM public.api_v2_config")).rows
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ id: true, enabled: false, allowed_roles: ["admin"], v1_sunset_at: null, v1_exempt_user_ids: [], v1_notice_sent_at: null })
    })

    it("RLS and grants unchanged: anon and authenticated have no privileges, RLS on", async () => {
      for (const role of ["anon", "authenticated"]) {
        const r = (await db.query("SELECT has_table_privilege($1, 'public.api_v2_config', 'SELECT') AS s", [role])).rows[0]
        expect(r.s).toBe(false)
      }
      const rls = (await db.query("SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.api_v2_config'::regclass")).rows[0]
      expect(rls.r).toBe(true)
    })
  })
})
