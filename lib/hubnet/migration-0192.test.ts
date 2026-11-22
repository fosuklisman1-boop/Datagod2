// lib/hubnet/migration-0192.test.ts
// migrations/0192_hubnet_ref_reservations.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0192-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0192_hubnet_ref_reservations.sql"
const SELFTEST_FILE = "0192_hubnet_ref_reservations.selftest.sql"
const migration = () => read(FILE)

describe("0192 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("creates the table idempotently and locks it down", () => {
    const c = code(migration())
    expect(c).toMatch(/CREATE TABLE IF NOT EXISTS hubnet_ref_reservations/)
    expect(c).toMatch(/ref\s+text\s+PRIMARY KEY/)
    expect(c).toMatch(/CHECK \(kind IN \('data', 'airtime'\)\)/)
    expect(c).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(c).not.toMatch(/CREATE POLICY/i)
    expect(c).toMatch(/REVOKE ALL ON (TABLE )?(public\.)?hubnet_ref_reservations FROM PUBLIC, anon, authenticated/i)
    expect(c).toMatch(/GRANT SELECT, INSERT, DELETE ON hubnet_ref_reservations TO service_role/)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0192[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("buildRunString refuses a migration without COMMIT", () => {
    expect(() => buildRunString("BEGIN;", read(SELFTEST_FILE))).toThrow(/no COMMIT/)
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
async function makeDb(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(migration())
  return db
}
const ins = (db: any, ref: string, kind = "data") =>
  db.query(`INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ($1, $2, 'o1')`, [ref, kind])

describe.skipIf(!PGliteCtor)("0192 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = new PGliteCtor()
    await db.exec(ROLES)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0192/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.hubnet_ref_reservations') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await makeDb()
    await db.exec(migration())
  }, 60_000)

  it("a second insert of the same ref fails with 23505", async () => {
    const db = await makeDb()
    await ins(db, "R1")
    await expect(ins(db, "R1")).rejects.toMatchObject({ code: "23505" })
  })

  it("the CHECK rejects kind 'x' and accepts data/airtime", async () => {
    const db = await makeDb()
    await expect(ins(db, "R2", "x")).rejects.toThrow(/check/i)
    await ins(db, "R3", "data")
    await ins(db, "R4", "airtime")
  })

  it("anon and authenticated are denied select/insert/delete; service_role is allowed", async () => {
    const db = await makeDb()
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`SET ROLE ${role}`)
      await expect(db.exec(`INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ('X', 'data', 'o')`)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`SELECT * FROM hubnet_ref_reservations`)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`DELETE FROM hubnet_ref_reservations`)).rejects.toThrow(/permission denied/)
      await db.exec("RESET ROLE")
    }
    await db.exec("SET ROLE service_role")
    await ins(db, "S1")
    expect((await db.query(`SELECT count(*)::int AS n FROM hubnet_ref_reservations`)).rows[0].n).toBe(1)
    await db.exec(`DELETE FROM hubnet_ref_reservations WHERE ref = 'S1'`)
    await db.exec("RESET ROLE")
  })
})
