// migrations/0189_ai_conversations.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0189-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0189_ai_conversations.sql"
const SELFTEST_FILE = "0189_ai_conversations.selftest.sql"
const migration = () => read(FILE)

describe("0189 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("the run string has no COMMIT, no bare END; in the self-test, and ends by raising", () => {
    const run = buildRunString(migration(), read(SELFTEST_FILE))
    const s = code(run)
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0189[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("rejects a run string that could commit", () => {
    expect(() => buildRunString(migration() + "\nCOMMIT;", read(SELFTEST_FILE))).toThrow()
  })

  it("locks both tables away from client roles", () => {
    const m = code(migration())
    expect(m.match(/ENABLE ROW LEVEL SECURITY/gi)).toHaveLength(2)
    expect(m).toMatch(/REVOKE ALL ON public\.ai_conversations FROM anon, authenticated/)
    expect(m).toMatch(/REVOKE ALL ON public\.ai_conversation_messages FROM anon, authenticated/)
    expect(m).not.toMatch(/CREATE POLICY/i)
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
const STUBS = `CREATE TABLE public.users(id uuid PRIMARY KEY);`
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  return db
}

describe.skipIf(!PGliteCtor)("0189 in PGlite", () => {
  it("selftest_ok_when_client_has_write_grants: the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0189/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.ai_conversations') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  // Production shape: authenticated has SELECT only on some tables. New tables still get nothing for clients.
  it("selftest_ok_when_client_has_select_only", async () => {
    const db = await fresh()
    await db.exec(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;
    `)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0189/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.ai_conversations') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error and clients cannot read or write", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec(migration())
    for (const tbl of ["ai_conversations", "ai_conversation_messages"]) {
      for (const role of ["anon", "authenticated"]) {
        const r = await db.query(`SELECT has_table_privilege('${role}','public.${tbl}','SELECT') AS s, has_table_privilege('${role}','public.${tbl}','INSERT') AS i`)
        expect(r.rows[0]).toEqual({ s: false, i: false })
      }
      expect((await db.query(`SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.${tbl}'::regclass`)).rows[0].r).toBe(true)
    }
  }, 60_000)
})
