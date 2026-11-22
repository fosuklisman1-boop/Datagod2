// lib/auto-fulfil/migration-0193.test.ts
// migrations/0193_auto_fulfil.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0193-run"
import { COMBINED_ORDERS_VIEW_SQL } from "../order-queue/migration-0190.view-fixture"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0193_auto_fulfil.sql"
const SELFTEST_FILE = "0193_auto_fulfil.selftest.sql"
const migration = () => read(FILE)

describe("0193 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("locks the three tables down and has no policies", () => {
    const c = code(migration())
    expect(c).not.toMatch(/CREATE POLICY/i)
    expect(c.match(/ENABLE ROW LEVEL SECURITY/gi)).toHaveLength(3)
    expect(c).toMatch(/REVOKE ALL ON auto_fulfil_runs, auto_fulfil_attempts, auto_fulfil_settings_log FROM PUBLIC, anon, authenticated/)
  })

  it("the selftest never creates users (prod users.id references auth.users) and checks claim split grants", () => {
    const c = code(read(SELFTEST_FILE))
    expect(c).not.toMatch(/INSERT\s+INTO\s+(public\.)?users\b/i)
    expect(c).toMatch(/JOIN auth\.users/)
    expect(c).toMatch(/has_function_privilege\('anon', 'public\.claim_fulfillment_queue_split\(int,int\)', 'EXECUTE'\)/)
    expect(c).toMatch(/has_function_privilege\('authenticated', 'public\.claim_fulfillment_queue_split\(int,int\)', 'EXECUTE'\)/)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0193[^']*';\s*END\s*\$selftest\$;$/)
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
// fulfillment_queue: real definition from migrations/0087_fulfillment_queue.sql (table only).
// Source tables: same minimal shapes as lib/order-queue/migration-0190.test.ts. fulfillment_logs: migrations/add_fulfillment_logs_table.sql
// (order_id uuid, updated_at timestamp WITHOUT time zone).
const TABLES = `
  CREATE TABLE fulfillment_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID NOT NULL, order_id TEXT NOT NULL,
    order_type TEXT NOT NULL CHECK (order_type IN ('shop','bulk','api','ussd','ussd_shop')), provider TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
    attempt_count INT NOT NULL DEFAULT 0, error_message TEXT, enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempted_at TIMESTAMPTZ, completed_at TIMESTAMPTZ);
  -- Prod shape (migrations/tests/0171_admin_wallet_adjust_local_test.sql): public.users.id references auth.users(id).
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE TABLE users (id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, email varchar, created_at timestamp DEFAULT now());
  CREATE TABLE user_shops (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, shop_name varchar);
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, network varchar, size varchar, price numeric,
    status varchar, phone_number varchar, order_code varchar, transaction_code varchar, created_at timestamp DEFAULT now());
  CREATE TABLE api_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, network text, volume_gb numeric, price numeric,
    recipient_phone text, api_reference text, status text, created_at timestamptz DEFAULT now());
  CREATE TABLE shop_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, customer_email varchar, customer_phone varchar,
    network varchar, volume_gb numeric, total_price numeric, order_status varchar, payment_status varchar, transaction_id varchar,
    reference_code varchar, created_at timestamp DEFAULT now());
  CREATE TABLE ussd_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient_phone varchar, network varchar, package_size varchar,
    amount numeric, paystack_reference varchar, order_status varchar, payment_status varchar, shop_owner_id uuid,
    created_at timestamptz DEFAULT now());
  CREATE TABLE ussd_shop_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, recipient_phone varchar, network varchar,
    package_size varchar, amount numeric, paystack_reference varchar, order_status varchar, payment_status varchar,
    created_at timestamptz DEFAULT now());
  CREATE TABLE mtn_fulfillment_tracking (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_order_id uuid, mtn_order_id text,
    status varchar, created_at timestamp DEFAULT now(), order_id varchar, provider varchar, api_order_id uuid);
  CREATE TABLE fulfillment_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status varchar DEFAULT 'pending', created_at timestamp NOT NULL DEFAULT NOW(), updated_at timestamp NOT NULL DEFAULT NOW());
`
const USER = "00000000-0000-4000-8000-000000009000"
const SEED_USER = `
  INSERT INTO auth.users (id, email) VALUES ('${USER}', 'u@example.invalid');
  INSERT INTO users (id, email) VALUES ('${USER}', 'u@example.invalid');
`

async function makeDb(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(TABLES)
  await db.exec(`CREATE VIEW combined_orders_view AS ${COMBINED_ORDERS_VIEW_SQL}`)
  // A pre-existing queue row, to prove the new column backfills to 'admin'.
  await db.exec(`INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'pre-existing', 'bulk', 'completed')`)
  await db.exec(migration())
  await db.exec(SEED_USER)
  return db
}

const MIN_AGO = (m: number) => `now() - interval '${m} minutes'`
async function bulkOrder(db: any, minutesOld: number, o: { network?: string; status?: string } = {}): Promise<string> {
  const r = await db.query(
    `INSERT INTO orders (user_id, network, size, price, status, phone_number, created_at)
     VALUES ($1, $2, '1', 5, $3, '0000000000', ${MIN_AGO(minutesOld)}) RETURNING id::text AS id`,
    [USER, o.network ?? "MTN", o.status ?? "pending"])
  return r.rows[0].id
}
const candidates = async (db: any, minAge = 10, maxDays = 7, networks = ["MTN"], scan = 100): Promise<string[]> =>
  (await db.query(`SELECT id FROM auto_fulfil_candidates($1, $2, $3::text[], $4)`, [minAge, maxDays, networks, scan])).rows.map((r: any) => r.id)

// REQUIRE_PGLITE=1 turns a missing PGlite into a loud failure instead of a silent skip.
if (!PGliteCtor && process.env.REQUIRE_PGLITE === "1") {
  describe("0193 in PGlite", () => {
    it("requires PGlite", () => {
      throw new Error("REQUIRE_PGLITE=1 but @electric-sql/pglite could not be loaded: the 0193 database tests cannot run")
    })
  })
}

describe.skipIf(!PGliteCtor)("0193 in PGlite", () => {
  const bareDb = async (): Promise<any> => {
    const db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(TABLES)
    await db.exec(`CREATE VIEW combined_orders_view AS ${COMBINED_ORDERS_VIEW_SQL}`)
    return db
  }

  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await bareDb()
    await db.exec(SEED_USER)   // the selftest borrows an existing auth-linked user, as on prod
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0193/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.auto_fulfil_runs') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT to_regproc('auto_fulfil_candidates') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='fulfillment_queue' AND column_name='source'")).rows[0].n).toBe(0)
    expect((await db.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(1)
    expect((await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0)
  }, 60_000)

  it("the selftest fails clearly when no auth-linked user exists", async () => {
    const db = await bareDb()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^FAIL setup: no users row joined to auth\.users/)
    await db.exec("ROLLBACK")
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await makeDb()
    await db.exec(migration())
  }, 60_000)

  it("candidates: pending paid order 11 min old with no activity is returned; 9 min old is not", async () => {
    const db = await makeDb()
    const old = await bulkOrder(db, 11)
    const fresh = await bulkOrder(db, 9)
    const got = await candidates(db)
    expect(got).toContain(old)
    expect(got).not.toContain(fresh)
  }, 60_000)

  it("candidates: returns the documented columns, oldest first, capped by p_scan", async () => {
    const db = await makeDb()
    const a = await bulkOrder(db, 60)
    const b = await bulkOrder(db, 30)
    await bulkOrder(db, 20)
    const r = await db.query(`SELECT * FROM auto_fulfil_candidates(10, 7, ARRAY['MTN'], 2)`)
    expect(r.rows.map((x: any) => x.id)).toEqual([a, b])
    expect(Object.keys(r.rows[0]).sort()).toEqual(["created_at", "id", "network", "phone_number", "type"])
    expect(r.rows[0].type).toBe("bulk")
  }, 60_000)

  it("candidates: a queue row completed 5 min ago hides the order; one completed 15 min ago does not", async () => {
    const db = await makeDb()
    const recent = await bulkOrder(db, 60)
    const older = await bulkOrder(db, 60)
    await db.query(
      `INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status, enqueued_at, completed_at)
       VALUES (gen_random_uuid(), $1, 'bulk', 'completed', ${MIN_AGO(30)}, ${MIN_AGO(5)})`, [recent])
    await db.query(
      `INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status, enqueued_at, completed_at)
       VALUES (gen_random_uuid(), $1, 'bulk', 'completed', ${MIN_AGO(30)}, ${MIN_AGO(15)})`, [older])
    const got = await candidates(db)
    expect(got).not.toContain(recent)
    expect(got).toContain(older)
  }, 60_000)

  it("candidates: a queue row enqueued or attempted recently (any source/status) hides the order", async () => {
    const db = await makeDb()
    const enq = await bulkOrder(db, 60)
    const att = await bulkOrder(db, 60)
    await db.query(`INSERT INTO fulfillment_queue (batch_id, order_id, order_type, source, enqueued_at) VALUES (gen_random_uuid(), $1, 'bulk', 'auto', ${MIN_AGO(3)})`, [enq])
    await db.query(
      `INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status, enqueued_at, last_attempted_at)
       VALUES (gen_random_uuid(), $1, 'bulk', 'failed', ${MIN_AGO(40)}, ${MIN_AGO(2)})`, [att])
    const got = await candidates(db)
    expect(got).not.toContain(enq)
    expect(got).not.toContain(att)
  }, 60_000)

  it("candidates: a tracking row created 5 min ago (via shop_order_id) hides the order; one 15 min ago does not", async () => {
    const db = await makeDb()
    const hid = (await db.query(
      `INSERT INTO shop_orders (customer_phone, network, volume_gb, total_price, order_status, payment_status, created_at)
       VALUES ('0000000000', 'MTN', 1, 5, 'pending', 'completed', ${MIN_AGO(60)}) RETURNING id::text AS id`)).rows[0].id
    const shown = (await db.query(
      `INSERT INTO shop_orders (customer_phone, network, volume_gb, total_price, order_status, payment_status, created_at)
       VALUES ('0000000000', 'MTN', 1, 5, 'pending', 'completed', ${MIN_AGO(60)}) RETURNING id::text AS id`)).rows[0].id
    await db.query(`INSERT INTO mtn_fulfillment_tracking (shop_order_id, status, created_at) VALUES ($1, 'failed', ${MIN_AGO(5)})`, [hid])
    await db.query(`INSERT INTO mtn_fulfillment_tracking (shop_order_id, status, created_at) VALUES ($1, 'failed', ${MIN_AGO(15)})`, [shown])
    const got = await candidates(db)
    expect(got).not.toContain(hid)
    expect(got).toContain(shown)
  }, 60_000)

  it("candidates: tracking linked through order_id or api_order_id also hides the order", async () => {
    const db = await makeDb()
    const viaOrderId = await bulkOrder(db, 60)
    const api = (await db.query(
      `INSERT INTO api_orders (user_id, network, volume_gb, price, recipient_phone, status, created_at)
       VALUES ($1, 'MTN', 1, 5, '0000000000', 'pending', ${MIN_AGO(60)}) RETURNING id::text AS id`, [USER])).rows[0].id
    await db.query(`INSERT INTO mtn_fulfillment_tracking (order_id, status, created_at) VALUES ($1, 'failed', ${MIN_AGO(5)})`, [viaOrderId])
    await db.query(`INSERT INTO mtn_fulfillment_tracking (api_order_id, status, created_at) VALUES ($1, 'failed', ${MIN_AGO(5)})`, [api])
    const got = await candidates(db)
    expect(got).not.toContain(viaOrderId)
    expect(got).not.toContain(api)
  }, 60_000)

  it("candidates: a fulfillment_logs row updated 5 min ago hides the order; one 15 min ago does not (UTC wall clock, any session zone)", async () => {
    const db = await makeDb()
    const hid = await bulkOrder(db, 60)
    const shown = await bulkOrder(db, 60)
    // fulfillment_logs.updated_at is timestamp WITHOUT time zone, written as UTC wall clock (Supabase sessions are UTC).
    await db.query(`INSERT INTO fulfillment_logs (order_id, updated_at) VALUES ($1, (now() AT TIME ZONE 'UTC') - interval '5 minutes')`, [hid])
    await db.query(`INSERT INTO fulfillment_logs (order_id, updated_at) VALUES ($1, (now() AT TIME ZONE 'UTC') - interval '15 minutes')`, [shown])
    await db.exec(`SET TIME ZONE 'Pacific/Auckland'`)
    const got = await candidates(db)
    await db.exec(`RESET TIME ZONE`)
    expect(got).not.toContain(hid)
    expect(got).toContain(shown)
  }, 60_000)

  it("candidates: unpaid shop order, non-pending order, order older than max age, network not in list => not returned", async () => {
    const db = await makeDb()
    const unpaidShop = (await db.query(
      `INSERT INTO shop_orders (customer_phone, network, volume_gb, total_price, order_status, payment_status, created_at)
       VALUES ('0000000000', 'MTN', 1, 5, 'pending', 'pending', ${MIN_AGO(60)}) RETURNING id::text AS id`)).rows[0].id
    const unpaidUssd = (await db.query(
      `INSERT INTO ussd_orders (recipient_phone, network, amount, order_status, payment_status, created_at)
       VALUES ('0000000000', 'MTN', 5, 'pending', 'pending', ${MIN_AGO(60)}) RETURNING id::text AS id`)).rows[0].id
    const done = await bulkOrder(db, 60, { status: "completed" })
    const tooOld = await bulkOrder(db, 60 * 24 * 8)
    const otherNet = await bulkOrder(db, 60, { network: "Telecel" })
    const ok = await bulkOrder(db, 60)
    const got = await candidates(db)
    for (const id of [unpaidShop, unpaidUssd, done, tooOld, otherNet]) expect(got).not.toContain(id)
    expect(got).toContain(ok)
    expect(await candidates(db, 10, 7, ["Telecel"])).toEqual([otherNet])
  }, 60_000)

  describe("claim_fulfillment_queue_split", () => {
    const seed = async (db: any, source: string, n: number, tag: string) => {
      for (let i = 0; i < n; i++)
        await db.query(
          `INSERT INTO fulfillment_queue (batch_id, order_id, order_type, source, enqueued_at)
           VALUES (gen_random_uuid(), $1, 'bulk', $2, now() - make_interval(secs => $3))`, [`${tag}-${i}`, source, 1000 - i])
    }

    it("10 auto + 10 admin pending, p_limit 20 p_auto_limit 5 => 5 auto + 10 admin claimed", async () => {
      const db = await makeDb()
      await seed(db, "auto", 10, "a")
      await seed(db, "admin", 10, "m")
      const r = await db.query(`SELECT order_id, source FROM claim_fulfillment_queue_split(20, 5)`)
      expect(r.rows.filter((x: any) => x.source === "auto")).toHaveLength(5)
      expect(r.rows.filter((x: any) => x.source === "admin")).toHaveLength(10)
      // oldest auto rows first
      expect(r.rows.filter((x: any) => x.source === "auto").map((x: any) => x.order_id).sort()).toEqual(["a-0", "a-1", "a-2", "a-3", "a-4"])
    }, 60_000)

    it("claimed rows are processing with attempt_count 1; unclaimed stay pending", async () => {
      const db = await makeDb()
      await seed(db, "auto", 10, "a")
      await seed(db, "admin", 10, "m")
      const r = await db.query(`SELECT status, attempt_count, last_attempted_at FROM claim_fulfillment_queue_split(20, 5)`)
      expect(r.rows).toHaveLength(15)
      for (const row of r.rows) {
        expect(row.status).toBe("processing")
        expect(row.attempt_count).toBe(1)
        expect(row.last_attempted_at).not.toBeNull()
      }
      expect((await db.query(`SELECT count(*)::int AS n FROM fulfillment_queue WHERE status = 'pending' AND source = 'auto'`)).rows[0].n).toBe(5)
    }, 60_000)

    it("total never exceeds p_limit, admin rows have priority, and a zero or null auto limit claims no auto rows", async () => {
      const db = await makeDb()
      await seed(db, "auto", 10, "a")
      await seed(db, "admin", 4, "m")
      const r = await db.query(`SELECT source FROM claim_fulfillment_queue_split(6, 5)`)
      expect(r.rows.filter((x: any) => x.source === "admin")).toHaveLength(4)
      expect(r.rows.filter((x: any) => x.source === "auto")).toHaveLength(2)
      expect((await db.query(`SELECT count(*)::int AS n FROM claim_fulfillment_queue_split(20, 0)`)).rows[0].n).toBe(0)
      expect((await db.query(`SELECT count(*)::int AS n FROM claim_fulfillment_queue_split(20, NULL)`)).rows[0].n).toBe(0)
      expect((await db.query(`SELECT count(*)::int AS n FROM claim_fulfillment_queue_split(NULL, 5)`)).rows[0].n).toBe(0)
    }, 60_000)
  })

  it("existing fulfillment_queue rows get source 'admin'; source 'other' is rejected", async () => {
    const db = await makeDb()
    expect((await db.query(`SELECT source FROM fulfillment_queue WHERE order_id = 'pre-existing'`)).rows[0].source).toBe("admin")
    await expect(
      db.query(`INSERT INTO fulfillment_queue (batch_id, order_id, order_type, source) VALUES (gen_random_uuid(), 'x', 'bulk', 'other')`),
    ).rejects.toThrow(/check/i)
  }, 60_000)

  it("attempts: outcome may be NULL or a listed value, nothing else; run_id must exist", async () => {
    const db = await makeDb()
    const runId = (await db.query(`INSERT INTO auto_fulfil_runs DEFAULT VALUES RETURNING id`)).rows[0].id
    const ins = (outcome: string | null, run = runId) =>
      db.query(`INSERT INTO auto_fulfil_attempts (run_id, queue_id, order_id, order_type, outcome) VALUES ($1, gen_random_uuid(), 'o', 'bulk', $2)`, [run, outcome])
    await ins(null)
    await ins("rate_limited")
    await expect(ins("exploded")).rejects.toThrow(/check/i)
    await expect(ins(null, "00000000-0000-4000-8000-0000000000ff")).rejects.toThrow(/foreign key/i)
  }, 60_000)

  it("anon and authenticated cannot read the three tables or execute the functions; service_role can", async () => {
    const db = await makeDb()
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`SET ROLE ${role}`)
      for (const t of ["auto_fulfil_runs", "auto_fulfil_attempts", "auto_fulfil_settings_log"])
        await expect(db.exec(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`INSERT INTO auto_fulfil_settings_log (admin_id, new_value) VALUES (gen_random_uuid(), '{}')`)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`SELECT * FROM auto_fulfil_candidates(10, 7, ARRAY['MTN'], 10)`)).rejects.toThrow(/permission denied/)
      await expect(db.exec(`SELECT * FROM claim_fulfillment_queue_split(10, 5)`)).rejects.toThrow(/permission denied/)
      await db.exec("RESET ROLE")
    }
    await db.exec("SET ROLE service_role")
    await db.exec(`SELECT * FROM auto_fulfil_candidates(10, 7, ARRAY['MTN'], 10)`)
    await db.exec(`SELECT * FROM claim_fulfillment_queue_split(10, 5)`)
    await db.exec(`INSERT INTO auto_fulfil_settings_log (admin_id, new_value) VALUES (gen_random_uuid(), '{}')`)
    await db.exec("RESET ROLE")
  }, 60_000)
})
