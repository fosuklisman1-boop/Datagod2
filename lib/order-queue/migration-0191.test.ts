// lib/order-queue/migration-0191.test.ts
// migrations/0191_bulk_send_guard.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0191-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0191_bulk_send_guard.sql"
const SELFTEST_FILE = "0191_bulk_send_guard.selftest.sql"
const migration = () => read(FILE)

describe("0191 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("builds the index non-concurrently and locks the log down", () => {
    const c = code(migration())
    expect(c).not.toMatch(/CONCURRENTLY/i)
    expect(c).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_queue_one_live_per_order/)
    expect(c).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(c).not.toMatch(/CREATE POLICY/i)
    expect(c).toMatch(/REVOKE ALL ON (TABLE )?(public\.)?admin_bulk_send_log FROM PUBLIC, anon, authenticated/i)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0191[^']*';\s*END\s*\$selftest\$;$/)
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
// Real definition from migrations/0087_fulfillment_queue.sql (table only; the claim RPC is not touched).
const QUEUE = `
  CREATE TABLE fulfillment_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID NOT NULL, order_id TEXT NOT NULL,
    order_type TEXT NOT NULL CHECK (order_type IN ('shop','bulk','api','ussd','ussd_shop')), provider TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
    attempt_count INT NOT NULL DEFAULT 0, error_message TEXT, enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempted_at TIMESTAMPTZ, completed_at TIMESTAMPTZ);
`
async function makeDb(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(QUEUE)
  await db.exec(migration())
  return db
}
const ins = (db: any, orderId: string, status: string) =>
  db.query(`INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), $1, 'bulk', $2)`, [orderId, status])

describe.skipIf(!PGliteCtor)("0191 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(QUEUE)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0191/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.admin_bulk_send_log') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT to_regclass('public.fulfillment_queue_one_live_per_order') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await makeDb()
    await db.exec(migration())
  }, 60_000)

  it("refuses a second live row for the same order, pending or processing", async () => {
    const db = await makeDb()
    await ins(db, "o1", "pending")
    await expect(ins(db, "o1", "pending")).rejects.toThrow(/fulfillment_queue_one_live_per_order/)
    await expect(ins(db, "o1", "processing")).rejects.toThrow(/fulfillment_queue_one_live_per_order/)
  })

  it("ON CONFLICT DO NOTHING inserts zero rows for an already-live order", async () => {
    const db = await makeDb()
    await ins(db, "o2", "processing")
    const r = await db.query(
      `INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'o2', 'bulk', 'pending')
       ON CONFLICT (order_id) WHERE status IN ('pending','processing') DO NOTHING RETURNING id`)
    expect(r.rows).toHaveLength(0)
  })

  it("allows a new pending row beside completed/failed history", async () => {
    const db = await makeDb()
    await ins(db, "o3", "completed")
    await ins(db, "o3", "failed")
    await ins(db, "o3", "pending")
    expect((await db.query(`SELECT count(*)::int AS n FROM fulfillment_queue WHERE order_id='o3'`)).rows[0].n).toBe(3)
  })

  it("authenticated and anon cannot read or write the send log; service_role can", async () => {
    const db = await makeDb()
    const row = `INSERT INTO admin_bulk_send_log (admin_id, supplier, accepted_ids) VALUES (gen_random_uuid(), 'hubnet', ARRAY['a'])`
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`SET ROLE ${role}`)
      await expect(db.exec(row)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`SELECT * FROM admin_bulk_send_log`)).rejects.toThrow(/permission denied/)
      await db.exec("RESET ROLE")
    }
    await db.exec("SET ROLE service_role")
    await db.exec(row)
    expect((await db.query(`SELECT count(*)::int AS n FROM admin_bulk_send_log`)).rows[0].n).toBe(1)
    await db.exec("RESET ROLE")
  })
})
