// lib/roles/migration-0184.test.ts
// migrations/0184_roles_foundation.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0184 depends on public.packages and public.users; both are minimal stubs here (only the columns 0184 touches).
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0184-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0184_roles_foundation.sql"
const SELFTEST_FILE = "0184_roles_foundation.selftest.sql"
const migration = () => read(FILE)

describe("0184 migration text", () => {
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
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0184[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("mirror triggers terminate by value convergence, not pg_trigger_depth", () => {
    expect(code(migration())).not.toMatch(/pg_trigger_depth/i)
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
const STUBS = `
  CREATE TABLE public.packages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price numeric NOT NULL, dealer_price numeric);
  CREATE TABLE public.users(id uuid PRIMARY KEY, role text);
  INSERT INTO public.packages(price, dealer_price) VALUES (5, 4.50), (6, 0), (7, NULL);
  INSERT INTO public.users(id, role) VALUES (gen_random_uuid(), 'user'), (gen_random_uuid(), 'dealer'), (gen_random_uuid(), NULL);
`
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  return db
}

describe.skipIf(!PGliteCtor)("0184 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0184/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.roles') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error and seeds exactly 4 roles", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec(migration())
    expect((await db.query("SELECT count(*)::int AS n FROM roles")).rows[0].n).toBe(4)
    expect((await db.query("SELECT count(*)::int AS n FROM role_package_prices")).rows[0].n).toBe(1)
  }, 60_000)

  it("a new package inserted with a dealer price gets a dealer row", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec("INSERT INTO packages(id, price, dealer_price) VALUES ('00000000-0000-0000-0000-000000000042', 9, 5)")
    const r = await db.query("SELECT price::text AS p FROM role_package_prices WHERE package_id = '00000000-0000-0000-0000-000000000042'")
    expect(r.rows.map((x: any) => x.p)).toEqual(["5.00"])
  }, 60_000)
})
