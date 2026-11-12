// lib/rate-limit-fallback-migration.test.ts
// migrations/0164_rate_limit_fallback.sql and its self-test. Same harness style as lib/api-v1/migration-0163.test.ts.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0164_rate_limit_fallback.sql"
const SELFTEST_FILE = "0164_rate_limit_fallback.selftest.sql"
const migration = () => read(FILE)
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")

function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map(l => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0164: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex(l => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0164: run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0164: run string does not end by raising")
  return run
}
const runString = () => buildRunString(migration(), read(SELFTEST_FILE))

describe("0164 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("has the table with RLS on and no policy, no anon/authenticated access", () => {
    const c = code(migration())
    expect(c).toMatch(/PRIMARY KEY \(bucket, window_start\)/)
    expect(c).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(c).not.toMatch(/CREATE POLICY/i)
    expect(c).toMatch(/REVOKE ALL ON public\.rate_limit_fallback FROM PUBLIC, anon, authenticated/)
  })

  it("the RPC is SECURITY DEFINER with a pinned search_path and service_role-only EXECUTE", () => {
    const c = code(migration())
    expect(c).toMatch(/SECURITY DEFINER/)
    expect(c).toMatch(/SET search_path = public/)
    expect(c).toMatch(/REVOKE EXECUTE ON FUNCTION public\.rate_limit_fallback_hit\(text, int, int\) FROM PUBLIC, anon, authenticated/)
    expect(c).toMatch(/GRANT EXECUTE ON FUNCTION public\.rate_limit_fallback_hit\(text, int, int\) TO service_role/)
    const grants = c.split(";").map(s => s.trim()).filter(s => /^GRANT\b/i.test(s))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/\sTO service_role$/)
    expect(grants[0]).not.toMatch(/\b(anon|authenticated)\b|\bTO PUBLIC\b/)
  })

  it("counts with a single atomic upsert and validates its inputs", () => {
    const c = code(migration())
    expect(c).toMatch(/ON CONFLICT \(bucket, window_start\) DO UPDATE SET hits = r\.hits \+ 1\s+RETURNING r\.hits/)
    expect(c).toMatch(/floor\(extract\(epoch FROM now\(\)\) \/ p_window_seconds\) \* p_window_seconds/)
    expect(c).toMatch(/p_max <= 0/)
    expect(c).toMatch(/p_window_seconds <= 0/)
    expect(c).toMatch(/random\(\) < 0\.01/)
    expect(c).toMatch(/window_start < now\(\) - interval '1 hour'/)
  })
})

describe("0164 run string (migration + self-test)", () => {
  it("has no COMMIT and no bare END; statement, and ends with the always-raising DO block", () => {
    const s = code(runString())
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0164[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("the builder refuses a second COMMIT and a self-test that does not raise last", () => {
    const m = migration()
    const st = read(SELFTEST_FILE)
    expect(() => buildRunString(m.replace(/^BEGIN;/m, "BEGIN;\nCOMMIT;"), st)).toThrow(/could commit/)
    expect(() => buildRunString(m, st.replace(/RAISE EXCEPTION 'SELFTEST_OK[^']*';/, ""))).toThrow(/does not end by raising/)
  })
})

async function loadPGlite(): Promise<any> {
  try {
    const name = "@electric-sql/pglite"
    return (await import(/* @vite-ignore */ name)).PGlite
  } catch {
    return null
  }
}
const PGliteCtor = await loadPGlite()

const SETUP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
`

describe.skipIf(!PGliteCtor)("0164 in PGlite", () => {
  let db: any
  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(SETUP)
  }, 60_000)

  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    try {
      await expect(db.exec(runString())).rejects.toThrow(/SELFTEST_OK 0164/)
    } finally {
      await db.exec("ROLLBACK")
    }
    const r = (await db.query("SELECT to_regclass('public.rate_limit_fallback') AS t")).rows[0]
    expect(r.t).toBeNull()
  })

  it("applies twice (idempotent) and counts a fixed window", async () => {
    await db.exec(migration())
    await db.exec(migration())
    const hit = async (b: string) => (await db.query("SELECT * FROM public.rate_limit_fallback_hit($1, 2, 60)", [b])).rows[0]
    expect((await hit("x")).allowed).toBe(true)
    expect((await hit("x")).allowed).toBe(true)
    expect((await hit("x")).allowed).toBe(false)
    expect((await hit("y")).remaining).toBe(1)
  })
})
