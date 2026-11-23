// lib/strict-verify/migration-0194.test.ts
// migrations/0194_strict_supplier_verification.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0194-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0194_strict_supplier_verification.sql"
const SELFTEST_FILE = "0194_strict_supplier_verification.selftest.sql"
const migration = () => read(FILE)

describe("0194 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("locks both tables down and has no policies", () => {
    const c = code(migration())
    expect(c).not.toMatch(/CREATE POLICY/i)
    expect(c.match(/ENABLE ROW LEVEL SECURITY/gi)).toHaveLength(2)
    expect(c).toMatch(/REVOKE ALL ON mtn_supplier_verdicts, mtn_strict_holds FROM PUBLIC, anon, authenticated/)
  })

  it("has PRE-CHECK and VERIFY header comments", () => {
    const m = migration()
    expect(m).toMatch(/^-- PRE-CHECK/m)
    expect(m).toMatch(/^-- VERIFY/m)
  })

  it("the selftest touches no orders or users", () => {
    const c = code(read(SELFTEST_FILE))
    expect(c).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?(users|orders|shop_orders|api_orders|ussd_orders|ussd_shop_orders)\b/i)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0194[^']*';\s*END\s*\$selftest\$;$/)
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

// REQUIRE_PGLITE=1 turns a missing PGlite into a loud failure instead of a silent skip.
if (!PGliteCtor && process.env.REQUIRE_PGLITE === "1") {
  describe("0194 in PGlite", () => {
    it("requires PGlite", () => {
      throw new Error("REQUIRE_PGLITE=1 but @electric-sql/pglite could not be loaded: the 0194 database tests cannot run")
    })
  })
}

describe.skipIf(!PGliteCtor)("0194 in PGlite", () => {
  const PHONE = "0000000000"
  const hold = (db: any, over: Record<string, any> = {}) => {
    const r: { order_table: string; order_id: string; phone: string; reason: string; state?: string } =
      { order_table: "orders", order_id: "o1", phone: PHONE, reason: "rejected", ...over }
    return db.query(
      `INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason, state) VALUES ($1, $2, $3, $4, COALESCE($5, 'open'))`,
      [r.order_table, r.order_id, r.phone, r.reason, r.state ?? null])
  }

  it("verdicts: only yes/no, primary key (phone, supplier) upserts, checked_at defaults", async () => {
    const db = await makeDb()
    const ins = (v: string) => db.query(`INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ($1, 'sup-a', $2)`, [PHONE, v])
    await expect(ins("maybe")).rejects.toThrow(/check/i)
    await ins("no")
    await expect(ins("yes")).rejects.toThrow(/duplicate key|unique/i)
    await db.query(
      `INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ($1, 'sup-a', 'yes')
       ON CONFLICT (phone, supplier) DO UPDATE SET verdict = EXCLUDED.verdict, checked_at = now()`, [PHONE])
    await db.query(`INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ($1, 'sup-b', 'no')`, [PHONE])
    const r = (await db.query(`SELECT supplier, verdict, checked_at IS NOT NULL AS has_ts FROM mtn_supplier_verdicts ORDER BY supplier`)).rows
    expect(r).toEqual([
      { supplier: "sup-a", verdict: "yes", has_ts: true },
      { supplier: "sup-b", verdict: "no", has_ts: true },
    ])
  }, 60_000)

  it("holds: defaults, and bad order_table / reason / state are rejected", async () => {
    const db = await makeDb()
    await hold(db)
    const r = (await db.query(`SELECT state, sms_sent, closed_at, last_checked_at, held_at IS NOT NULL AS has_held FROM mtn_strict_holds`)).rows[0]
    expect(r).toEqual({ state: "open", sms_sent: false, closed_at: null, last_checked_at: null, has_held: true })
    for (const t of ["orders", "shop_orders", "api_orders", "ussd_orders", "ussd_shop_orders"]) await hold(db, { order_table: t, order_id: "x" })
    await expect(hold(db, { order_table: "bulk", order_id: "y" })).rejects.toThrow(/check/i)
    await expect(hold(db, { order_id: "z", reason: "because" })).rejects.toThrow(/check/i)
    await expect(hold(db, { order_id: "w", state: "paused" })).rejects.toThrow(/check/i)
    for (const [i, s] of ["released", "expired"].entries()) await hold(db, { order_id: `s${i}`, reason: "unanswered", state: s })
    await expect(db.query(`INSERT INTO mtn_strict_holds (order_table, order_id, reason) VALUES ('orders', 'np', 'rejected')`)).rejects.toThrow(/not-null|null value/i)
  }, 60_000)

  it("holds: primary key is (order_table, order_id); the same id in another table is allowed", async () => {
    const db = await makeDb()
    await hold(db)
    await expect(hold(db, { reason: "unanswered" })).rejects.toThrow(/duplicate key|unique/i)
    await hold(db, { order_table: "shop_orders" })
    await db.query(
      `INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason) VALUES ('orders', 'o1', $1, 'unanswered')
       ON CONFLICT (order_table, order_id) DO UPDATE SET reason = EXCLUDED.reason`, [PHONE])
    expect((await db.query(`SELECT reason FROM mtn_strict_holds WHERE order_table = 'orders' AND order_id = 'o1'`)).rows[0].reason).toBe("unanswered")
  }, 60_000)

  it("holds: the (state, last_checked_at) index and the partial open-phone index exist", async () => {
    const db = await makeDb()
    const idx = (await db.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'mtn_strict_holds'`)).rows.map((r: any) => r.indexdef as string)
    expect(idx.some((d: string) => d.includes("(state, last_checked_at)"))).toBe(true)
    expect(idx.some((d: string) => d.includes("(phone)") && /WHERE \(?state = 'open'/.test(d))).toBe(true)
  }, 60_000)

  it("applies twice without error and keeps existing rows", async () => {
    const db = await makeDb()
    await hold(db)
    await db.exec(migration())
    expect((await db.query(`SELECT count(*)::int AS n FROM mtn_strict_holds`)).rows[0].n).toBe(1)
  }, 60_000)

  it("anon and authenticated cannot touch either table; service_role can (verdict DELETE included)", async () => {
    const db = await makeDb()
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`SET ROLE ${role}`)
      for (const t of ["mtn_supplier_verdicts", "mtn_strict_holds"])
        await expect(db.exec(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ('0000000000', 's', 'yes')`)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason) VALUES ('orders', 'a', '0000000000', 'rejected')`)).rejects.toThrow(/permission denied/)
      await db.exec("RESET ROLE")
    }
    await db.exec("SET ROLE service_role")
    await db.exec(`INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ('0000000000', 's', 'yes')`)
    await db.exec(`UPDATE mtn_supplier_verdicts SET verdict = 'no'`)
    await db.exec(`SELECT * FROM mtn_supplier_verdicts`)
    await db.exec(`DELETE FROM mtn_supplier_verdicts`)
    await db.exec(`INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason) VALUES ('orders', 'a', '0000000000', 'rejected')`)
    await db.exec(`UPDATE mtn_strict_holds SET state = 'released', closed_at = now()`)
    await db.exec(`SELECT * FROM mtn_strict_holds`)
    await db.exec("RESET ROLE")
  }, 60_000)

  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = new PGliteCtor()
    await db.exec(ROLES)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0194/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.mtn_supplier_verdicts') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT to_regclass('public.mtn_strict_holds') AS t")).rows[0].t).toBeNull()
  }, 60_000)
})
