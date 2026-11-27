// migrations/0203_ai_voice_queue.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "../ai-console/migration-0189-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0203_ai_voice_queue.sql"
const SELFTEST_FILE = "0203_ai_voice_queue.selftest.sql"
const migration = () => read(FILE)

describe("0203 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '\d+s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("the run string has no COMMIT and ends by raising SELFTEST_OK", () => {
    const run = buildRunString(migration(), read(SELFTEST_FILE))
    expect(code(run)).not.toMatch(/\bCOMMIT\b/i)
    expect(code(run).trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0203[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("locks the table down to the service role", () => {
    const c = code(migration())
    expect(c).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(c).toMatch(/REVOKE ALL ON TABLE public\.ai_voice_queue FROM PUBLIC, anon, authenticated/i)
    expect(c).toMatch(/GRANT ALL ON TABLE public\.ai_voice_queue TO service_role/i)
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
const STUBS = `CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
  INSERT INTO auth.users(id) VALUES ('00000000-0000-4000-8000-000000000001');`
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  return db
}

describe.skipIf(!PGliteCtor)("0203 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves no table behind", async () => {
    const db = await fresh()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0203/)
    await db.exec("ROLLBACK")
    const r = await db.query("select to_regclass('public.ai_voice_queue') as t")
    expect(r.rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice, defaults to waiting, and refuses bad rows", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec(migration())
    await db.exec(`INSERT INTO public.ai_voice_queue(device_hash, context, mode) VALUES ('d', 'home', 'voice')`)
    const r = await db.query("select status from public.ai_voice_queue")
    expect(r.rows[0].status).toBe("waiting")
    let c = ""
    try { await db.exec(`INSERT INTO public.ai_voice_queue(context, mode) VALUES ('home', 'voice')`) } catch (e: any) { c = e.code }
    expect(c).toBe("23514")
    c = ""
    try { await db.exec(`INSERT INTO public.ai_voice_queue(device_hash, context, mode, status) VALUES ('d', 'home', 'voice', 'bogus')`) } catch (e: any) { c = e.code }
    expect(c).toBe("23514")
  }, 60_000)
})
