// lib/blocked-numbers/migration-0182.test.ts
// migrations/0182_mtn_blocked_numbers.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0182 has no dependency on earlier migrations beyond the Supabase roles.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0182-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0182_mtn_blocked_numbers.sql"
const SELFTEST_FILE = "0182_mtn_blocked_numbers.selftest.sql"
const migration = () => read(FILE)

describe("0182 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0182[^']*';\s*END\s*\$selftest\$;$/)
  })
})

async function loadPGlite(): Promise<any> {
  try {
    const name = "@electric-sql/pglite" // a variable: nothing may resolve this at transform time
    return (await import(/* @vite-ignore */ name)).PGlite
  } catch {
    return null
  }
}
const PGliteCtor = await loadPGlite()

const ROLES = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`

describe.skipIf(!PGliteCtor)("0182 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = new PGliteCtor()
    await db.exec(ROLES)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0182/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.mtn_blocked_numbers') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error", async () => {
    const db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(migration())
    await db.exec(migration())
    expect((await db.query("SELECT count(*)::int AS n FROM pg_class WHERE oid = to_regclass('public.mtn_blocked_attempts')")).rows[0].n).toBe(1)
  }, 60_000)
})
