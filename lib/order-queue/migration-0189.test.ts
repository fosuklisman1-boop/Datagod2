// lib/order-queue/migration-0189.test.ts
// migrations/0189_admin_order_queue.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// The source tables behind combined_orders_view are created here in minimal form; the view is the real prod definition.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0189-run"
import { COMBINED_ORDERS_VIEW_SQL } from "./migration-0189.view-fixture"
import { FAILURE_REASON_FIXTURES } from "./failure-reason.fixtures"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0189_admin_order_queue.sql"
const SELFTEST_FILE = "0189_admin_order_queue.selftest.sql"
const migration = () => read(FILE)

describe("0189 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("does not create or alter the view or any table", () => {
    const c = code(migration())
    expect(c).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?(VIEW|TABLE)\b/i)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0189[^']*';\s*END\s*\$selftest\$;$/)
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

// Minimal source tables, real column types (see schema reference). Only columns the view and the functions read.
const TABLES = `
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar);
  CREATE TABLE user_shops (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, shop_name varchar);
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, network varchar, size varchar, price numeric,
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
    api_response_payload jsonb, status varchar, external_message text, created_at timestamp DEFAULT now(), order_id varchar,
    provider varchar, api_order_id uuid);
`

async function makeDb(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(TABLES)
  await db.exec(`CREATE VIEW combined_orders_view AS ${COMBINED_ORDERS_VIEW_SQL}`)
  await db.exec(migration())
  return db
}

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const HOURS = (h: number) => `now() - interval '${h} hours'`

// Order rows live in `orders` (bulk) unless noted. status, age (hours), attempts oldest-first.
interface Seed {
  n: number
  status: string
  ageH?: number
  phone?: string
  attempts?: Array<{ status: string; ageH?: number; mtn?: string | null; msg?: string | null; provider?: string }>
}

async function seed(db: any, rows: Seed[]) {
  for (const r of rows) {
    await db.query(
      `INSERT INTO orders (id, network, size, price, status, phone_number, order_code, created_at)
       VALUES ($1, 'mtn', '1', 5, $2, $3, $4, ${HOURS(r.ageH ?? 1)})`,
      [uid(r.n), r.status, r.phone ?? `05000000${String(r.n).padStart(2, "0")}`, `ORD${r.n}`],
    )
    for (const a of r.attempts ?? []) {
      await db.query(
        `INSERT INTO mtn_fulfillment_tracking (order_id, status, mtn_order_id, external_message, provider, created_at)
         VALUES ($1, $2, $3, $4, $5, ${HOURS(a.ageH ?? 0.5)})`,
        [uid(r.n), a.status, a.mtn ?? null, a.msg ?? null, a.provider ?? "hubnet"],
      )
    }
  }
}

async function list(db: any, view: string, o: Partial<Record<string, any>> = {}) {
  const res = await db.query(
    `SELECT * FROM admin_order_queue($1::text, $2::text[], $3::text[], $4::text[], $5::timestamptz, $6::timestamptz,
       $7::text, $8::text, $9::text, $10::int, $11::int)`,
    [view, o.statuses ?? null, o.networks ?? null, o.types ?? null, o.from ?? null, o.to ?? null, o.search ?? null,
     o.provider ?? null, o.reason ?? null, o.limit ?? 50, o.offset ?? 0],
  )
  return res.rows as any[]
}
async function counts(db: any, o: Partial<Record<string, any>> = {}) {
  const res = await db.query(
    `SELECT * FROM admin_order_queue_counts($1::text[], $2::text[], $3::timestamptz, $4::timestamptz, $5::text, $6::text, $7::text)`,
    [o.networks ?? null, o.types ?? null, o.from ?? null, o.to ?? null, o.search ?? null, o.provider ?? null, o.reason ?? null],
  )
  return Object.fromEntries(res.rows.map((r: any) => [r.view, Number(r.n)])) as Record<string, number>
}
const ids = (rows: any[]) => rows.map((r) => r.id).sort()
const want = (...ns: number[]) => ns.map(uid).sort()

const SEEDS: Seed[] = [
  { n: 1, status: "pending" },
  { n: 2, status: "reversed", attempts: [{ status: "reversed" }] },
  { n: 3, status: "processing", attempts: [{ status: "abandoned" }] },
  { n: 4, status: "processing", attempts: [{ status: "processing", mtn: "UNKNOWN_x" }] },
  { n: 5, status: "processing", attempts: [{ status: "processing", ageH: 3 }] },
  { n: 6, status: "processing", attempts: [{ status: "pending", ageH: 1 }] },
  { n: 7, status: "failed", attempts: [{ status: "abandoned", ageH: 2 }, { status: "failed", ageH: 1, msg: "Insufficient balance for 2GB", provider: "kuntanii" }] },
  { n: 8, status: "completed", attempts: [{ status: "completed" }] },
  { n: 9, status: "failed", ageH: 240, attempts: [{ status: "failed", ageH: 240, msg: "boom" }] },
  { n: 10, status: "pending", ageH: 240 },
  { n: 11, status: "processing" }, // no attempt at all
]

describe.skipIf(!PGliteCtor)("0189 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(TABLES)
    await db.exec(`CREATE VIEW combined_orders_view AS ${COMBINED_ORDERS_VIEW_SQL}`)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0189/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regprocedure('public.admin_order_queue_counts(text[],text[],timestamptz,timestamptz,text,text,text)') AS f")).rows[0].f).toBeNull()
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await makeDb()
    await db.exec(migration())
    expect((await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('admin_order_queue','admin_order_queue_counts')")).rows[0].n).toBe(2)
  }, 60_000)

  it("each view returns exactly its seeded rows, and counts equal the list totals", async () => {
    const db = await makeDb()
    await seed(db, SEEDS)
    // needs_action ignores the 7-day default window (order 10 is 10 days old)
    expect(ids(await list(db, "needs_action"))).toEqual(want(1, 2, 10))
    // held: abandoned latest attempt, or UNKNOWN_ id; never a processing order without such an attempt
    expect(ids(await list(db, "held"))).toEqual(want(3, 4))
    // stuck: processing, latest attempt pending/processing and older than 2h (order 4 is processing but fresh)
    expect(ids(await list(db, "stuck"))).toEqual(want(5))
    // failed uses the 7-day default window (order 9 is excluded); latest attempt wins (7 has two attempts)
    expect(ids(await list(db, "failed"))).toEqual(want(7))
    // all uses the 7-day default window too
    expect(ids(await list(db, "all"))).toEqual(want(1, 2, 3, 4, 5, 6, 7, 8, 11))
    // an explicit p_from widens failed and all
    const from = new Date(Date.now() - 30 * 86400_000).toISOString()
    expect(ids(await list(db, "failed", { from }))).toEqual(want(7, 9))
    expect(ids(await list(db, "all", { from }))).toHaveLength(11)

    const c = await counts(db)
    expect(c).toEqual({ needs_action: 3, held: 2, stuck: 1, failed: 1, all: 9 })
    for (const v of ["needs_action", "held", "stuck", "failed", "all"]) {
      const rows = await list(db, v)
      expect(Number(rows[0]?.total_count ?? 0)).toBe(c[v])
    }
    expect(await counts(db, { from })).toMatchObject({ failed: 2, all: 11, needs_action: 3 })
  }, 60_000)

  it("returns the latest attempt's fields, attempt_count, has_reversal, is_held and failure_reason", async () => {
    const db = await makeDb()
    await seed(db, SEEDS)
    const r7 = (await list(db, "failed"))[0]
    expect(r7).toMatchObject({
      last_provider: "kuntanii", last_attempt_status: "failed", last_error: "Insufficient balance for 2GB",
      attempt_count: 2, has_reversal: false, is_held: false, failure_reason: "out_of_balance", network: "MTN", type: "bulk",
      status: "failed", payment_status: "completed", payment_reference: "ORD7", volume_gb: "1",
    })
    expect(Number(r7.price)).toBe(5)
    const r2 = (await list(db, "needs_action")).find((r) => r.id === uid(2))
    expect(r2).toMatchObject({ has_reversal: true, failure_reason: "none", attempt_count: 1 })
    const held = await list(db, "held")
    expect(held.every((r) => r.is_held === true)).toBe(true)
    expect(held.find((r) => r.id === uid(3))?.failure_reason).toBe("outcome_unknown")
    const r11 = (await list(db, "all")).find((r) => r.id === uid(11))
    expect(r11).toMatchObject({ last_provider: null, attempt_count: 0, has_reversal: false, is_held: false, failure_reason: "none" })
  }, 60_000)

  it("filters: statuses, networks, types, provider, failure reason, window, offset", async () => {
    const db = await makeDb()
    await seed(db, SEEDS)
    expect(ids(await list(db, "all", { statuses: ["failed"] }))).toEqual(want(7))
    expect(await list(db, "all", { networks: ["Telecel"] })).toHaveLength(0)
    expect(await list(db, "all", { networks: ["MTN"] })).toHaveLength(9)
    expect(await list(db, "all", { types: ["shop"] })).toHaveLength(0)
    expect(ids(await list(db, "all", { provider: "kuntanii" }))).toEqual(want(7))
    expect(ids(await list(db, "all", { reason: "out_of_balance" }))).toEqual(want(7))
    expect(ids(await list(db, "all", { reason: "outcome_unknown" }))).toEqual(want(3, 4))
    expect((await counts(db, { reason: "outcome_unknown" })).held).toBe(2)
    expect((await counts(db, { provider: "kuntanii" })).all).toBe(1)
    const to = new Date(Date.now() + 60_000).toISOString()
    expect(await list(db, "all", { to })).toHaveLength(9)
    const page1 = await list(db, "all", { limit: 4, offset: 0 })
    const page2 = await list(db, "all", { limit: 4, offset: 4 })
    expect(page1).toHaveLength(4)
    expect(page2).toHaveLength(4)
    expect(Number(page1[0].total_count)).toBe(9)
    expect(new Set([...page1, ...page2].map((r) => r.id)).size).toBe(8)
  }, 60_000)

  it("orders find their attempts through shop_order_id and api_order_id as well as order_id", async () => {
    const db = await makeDb()
    const shop = uid(100)
    const shopOwner = uid(101)
    const shopRow = uid(102)
    await db.query(`INSERT INTO users (id, email) VALUES ($1, 'owner@example.com')`, [shopOwner])
    await db.query(`INSERT INTO user_shops (id, user_id, shop_name) VALUES ($1, $2, 'Ab_Shop 100%')`, [shopRow, shopOwner])
    await db.query(
      `INSERT INTO shop_orders (id, shop_id, customer_email, customer_phone, network, volume_gb, total_price, order_status, payment_status,
         transaction_id, created_at) VALUES ($1, $2, 'c@example.com', '0244000000', 'mtn', 1, 9, 'pending', 'completed', 'T1', now())`,
      [shop, shopRow],
    )
    await db.query(`INSERT INTO mtn_fulfillment_tracking (shop_order_id, status, provider, created_at) VALUES ($1, 'pending', 'apex', now())`, [shop])
    const api = uid(103)
    await db.query(`INSERT INTO api_orders (id, user_id, network, volume_gb, price, recipient_phone, api_reference, status) VALUES ($1, $2, 'mtn', 2, 8, '0244111111', 'REF-API', 'pending')`, [api, shopOwner])
    await db.query(`INSERT INTO mtn_fulfillment_tracking (api_order_id, status, provider, created_at) VALUES ($1, 'pending', 'hubnet', now())`, [api])
    const rows = await list(db, "needs_action")
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId[shop]).toMatchObject({ last_provider: "apex", type: "shop", store_name: "Ab_Shop 100%", shop_owner_email: "owner@example.com", customer_email: "c@example.com" })
    expect(byId[api]).toMatchObject({ last_provider: "hubnet", type: "api", shop_owner_email: "owner@example.com" })
  }, 60_000)

  it("search treats LIKE and list punctuation literally; a 'a,b)' search runs and matches only that literal", async () => {
    const db = await makeDb()
    const shopRow = uid(201)
    await db.query(`INSERT INTO user_shops (id, user_id, shop_name) VALUES ($1, NULL, 'Ab_Shop 100%')`, [shopRow])
    await db.query(`INSERT INTO user_shops (id, user_id, shop_name) VALUES ($1, NULL, 'AbXShop 1000')`, [uid(202)])
    for (const [n, sr, ref, email] of [[200, shopRow, "T200", "x@example.com"], [203, uid(202), "T203", "y@example.com"], [204, shopRow, "a,b)", "z@example.com"]] as const) {
      await db.query(
        `INSERT INTO shop_orders (id, shop_id, customer_email, customer_phone, network, volume_gb, total_price, order_status, payment_status,
           transaction_id, created_at) VALUES ($1, $2, $3, '0244000000', 'mtn', 1, 9, 'pending', 'completed', $4, now())`,
        [uid(n), sr, email, ref],
      )
    }
    expect(ids(await list(db, "all", { search: "a,b)" }))).toEqual(want(204))
    expect(ids(await list(db, "all", { search: "_Shop 100%" }))).toEqual(want(200, 204))
    expect(ids(await list(db, "all", { search: "Ab_Shop" }))).toEqual(want(200, 204))
    // a bare % is a literal percent sign (only the 'Ab_Shop 100%' shop has one), not match-everything
    expect(ids(await list(db, "all", { search: "%" }))).toEqual(want(200, 204))
    expect(await list(db, "all", { search: "_" })).toHaveLength(2) // only the shop name with an underscore; not any-single-char
    expect(ids(await list(db, "all", { search: "Y@EXAMPLE" }))).toEqual(want(203))
    expect(await list(db, "all", { search: "\\" })).toHaveLength(0)
    expect((await counts(db, { search: "a,b)" })).all).toBe(1)
  }, 60_000)

  it("clamps p_limit to 1..200", async () => {
    const db = await makeDb()
    await db.exec(`INSERT INTO orders (network, size, price, status, phone_number, created_at)
                   SELECT 'mtn', '1', 1, 'pending', '0500000000', now() FROM generate_series(1, 230)`)
    expect(await list(db, "all", { limit: 5000 })).toHaveLength(200)
    expect(await list(db, "all", { limit: 0 })).toHaveLength(1)
    expect(await list(db, "all", { limit: -3 })).toHaveLength(1)
    expect(Number((await list(db, "all", { limit: 5000 }))[0].total_count)).toBe(230)
  }, 60_000)

  it("failure_reason in SQL equals the TypeScript classifier's expected value for every fixture", async () => {
    const db = await makeDb()
    for (const [i, f] of FAILURE_REASON_FIXTURES.entries()) {
      const n = 300 + i
      await db.query(`INSERT INTO orders (id, network, size, price, status, phone_number, created_at) VALUES ($1, 'mtn', '1', 1, 'failed', '0500000000', now())`, [uid(n)])
      if (f.input) {
        await db.query(
          `INSERT INTO mtn_fulfillment_tracking (order_id, status, mtn_order_id, external_message, created_at) VALUES ($1, $2, $3, $4, now())`,
          [uid(n), f.input.status, f.input.mtnOrderId, f.input.message],
        )
      }
    }
    const rows = await list(db, "all", { limit: 200 })
    const got = Object.fromEntries(rows.map((r) => [r.id, r.failure_reason]))
    FAILURE_REASON_FIXTURES.forEach((f, i) => {
      expect({ i, got: got[uid(300 + i)] }).toEqual({ i, got: f.expected })
    })
  }, 60_000)

  it("a message only in api_response_payload is still classified, and wildcards in the id prefix are literal", async () => {
    const db = await makeDb()
    await db.query(`INSERT INTO orders (id, network, size, price, status, phone_number, created_at) VALUES ($1, 'mtn', '1', 1, 'failed', '0500000000', now())`, [uid(400)])
    await db.query(`INSERT INTO mtn_fulfillment_tracking (order_id, status, api_response_payload, created_at) VALUES ($1, 'failed', '{"message":"No active bundle found"}', now())`, [uid(400)])
    await db.query(`INSERT INTO orders (id, network, size, price, status, phone_number, created_at) VALUES ($1, 'mtn', '1', 1, 'failed', '0500000000', now())`, [uid(401)])
    await db.query(`INSERT INTO mtn_fulfillment_tracking (order_id, status, mtn_order_id, external_message, created_at) VALUES ($1, 'failed', 'UNKNOWNXabc', 'nope', now())`, [uid(401)])
    await db.query(`INSERT INTO orders (id, network, size, price, status, phone_number, created_at) VALUES ($1, 'mtn', '1', 1, 'failed', '0500000000', now())`, [uid(402)])
    await db.query(`INSERT INTO mtn_fulfillment_tracking (order_id, status, external_message, created_at) VALUES ($1, 'failed', 'orders paused, not on beneficiary list', now())`, [uid(402)])
    const got = Object.fromEntries((await list(db, "all")).map((r) => [r.id, r.failure_reason]))
    expect(got[uid(400)]).toBe("no_bundle")
    expect(got[uid(401)]).toBe("rejected") // UNKNOWNX... is not an UNKNOWN_ id
    expect(got[uid(402)]).toBe("rejected") // underscores in the keywords are literal, not wildcards
  }, 60_000)

  it("anon and authenticated cannot EXECUTE either function; service_role can", async () => {
    const db = await makeDb()
    const A = "public.admin_order_queue(text, text[], text[], text[], timestamptz, timestamptz, text, text, text, int, int)"
    const B = "public.admin_order_queue_counts(text[], text[], timestamptz, timestamptz, text, text, text)"
    for (const [role, expected] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      for (const fn of [A, B]) {
        const r = await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])
        expect({ role, fn, ok: r.rows[0].ok }).toEqual({ role, fn, ok: expected })
      }
    }
  }, 60_000)
})
