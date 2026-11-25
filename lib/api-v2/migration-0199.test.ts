// lib/api-v2/migration-0199.test.ts
// migrations/0199_api_developer_dashboard.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real
// database. 0199 reads 0128 (api_v2_keys, api_v2_logs, loaded for real) plus stubs shaped as production has them:
// error_reason (0195), api_orders, api_v2_idempotency (0132 + kinds) and wallets.
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0199-run"
import { mapOrderStatus } from "./data-orders"
import { mapCommissionStatus } from "./commission"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0199_api_developer_dashboard.sql"
const SELFTEST_FILE = "0199_api_developer_dashboard.selftest.sql"
const migration = () => read(FILE)

const FUNCTIONS = [
  "api_v2_dev_usage(uuid,integer,text)",
  "api_v2_dev_logs(uuid,jsonb,timestamptz,uuid,integer)",
  "api_v2_dev_orders(uuid,jsonb,timestamptz,text,integer)",
  "api_v2_set_balance_alert(uuid,numeric)",
  "api_v2_get_balance_alert(uuid)",
  "api_v2_balance_alert_scan(timestamptz)",
  "api_v2_logs_retention(timestamptz)",
]

describe("0199 migration text", () => {
  it("one BEGIN, both SET LOCALs, one COMMIT; run string ends RAISE 'SELFTEST_OK 0199' and has no COMMIT", () => {
    const c = code(migration())
    expect(c.match(/^BEGIN;\s*$/gm)).toHaveLength(1)
    expect(c).toMatch(/SET LOCAL lock_timeout = '2s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '15s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0199';\s*END\s*\$selftest\$;$/)
    expect(() => buildRunString(migration().replace(/^COMMIT;$/m, ""), read(SELFTEST_FILE))).toThrow(/0199:no COMMIT/)
  })

  it("header has PRE-CHECKS and VERIFY; no ALTER/INDEX on an existing table; no foreign key", () => {
    const m = migration()
    const header = m.slice(0, m.indexOf("\nBEGIN;"))
    expect(header).toContain("PRE-CHECKS")
    expect(header).toContain("VERIFY")
    const c = code(m)
    expect(c).not.toMatch(/ALTER TABLE\s+(IF EXISTS\s+)?(ONLY\s+)?(public\.)?(api_v2_keys|api_v2_logs|api_v2_config|api_orders|api_v2_idempotency|wallets)\b/i)
    expect(c).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i)
    expect(c).not.toMatch(/REFERENCES/i)
  })

  it("every function is SECURITY DEFINER, pinned search_path, revoked from PUBLIC/anon/authenticated", () => {
    const c = code(migration())
    expect((c.match(/SECURITY DEFINER/g) ?? []).length).toBe(FUNCTIONS.length)
    expect((c.match(/SET search_path = public, pg_temp/g) ?? []).length).toBe(FUNCTIONS.length)
    expect((c.match(/FROM PUBLIC, anon, authenticated/g) ?? []).length).toBe(FUNCTIONS.length + 1)
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

const ROLES = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`
const STUBS = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
`
const STUBS_AFTER = `
  ALTER TABLE public.api_v2_logs ADD COLUMN IF NOT EXISTS error_reason text;
  CREATE TABLE public.api_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, api_key_id uuid, api_v2_key_id uuid,
    package_id uuid, network text, volume_gb numeric, price numeric, recipient_phone text, api_reference text, status text,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.api_v2_idempotency(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, api_v2_key_id uuid NOT NULL,
    kind text NOT NULL, reference text NOT NULL, request_hash text NOT NULL DEFAULT repeat('a', 64), status text NOT NULL DEFAULT 'in_progress',
    order_ref text, response jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE (user_id, kind, reference));
  CREATE TABLE public.wallets(user_id uuid PRIMARY KEY, balance numeric, updated_at timestamptz);
  CREATE TABLE public.airtime_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, reference_code text UNIQUE, status text);
  CREATE TABLE public.hubtel_bill_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, reference_code text UNIQUE, status text);
  CREATE TABLE public.hubtel_data_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, reference_code text UNIQUE, status text);
  CREATE TABLE public.results_checker_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, reference_code text UNIQUE, status text);
  CREATE TABLE public.afa_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, order_code text, status varchar(30));
`
const opened: any[] = []
afterEach(async () => {
  while (opened.length) await opened.pop().close().catch(() => undefined)
})
async function fresh99(): Promise<any> {
  const db = new PGliteCtor()
  opened.push(db)
  await db.exec(ROLES)
  await db.exec(STUBS)
  await db.exec(read("0128_api_v2_foundation.sql"))
  await db.exec(STUBS_AFTER)
  await db.exec(migration())
  return db
}

async function rows(db: any, sql: string): Promise<any[]> {
  return (await db.query(sql)).rows
}
async function one(db: any, sql: string): Promise<any> {
  return (await rows(db, sql))[0]
}
const lit = (x: unknown): string =>
  x === null || x === undefined ? "NULL" : typeof x === "number" ? String(x) : `'${String(typeof x === "object" ? JSON.stringify(x) : x).replace(/'/g, "''")}'`
async function call(db: any, fn: string, ...args: unknown[]): Promise<any> {
  return (await one(db, `SELECT public.${fn}(${args.map(lit).join(", ")}) AS r`)).r
}
async function mkUser(db: any): Promise<string> {
  const id = (await one(db, "SELECT gen_random_uuid() AS id")).id
  await db.exec(`INSERT INTO auth.users(id) VALUES ('${id}')`)
  return id
}
async function mkKey(db: any, user: string, o: { env?: string; type?: string } = {}): Promise<string> {
  return (
    await one(
      db,
      `INSERT INTO api_v2_keys(user_id, key_type, environment, status, name, key_hash, key_prefix)
       VALUES ('${user}', '${o.type ?? "standard"}', '${o.env ?? "live"}', 'active', 'k', 'h-' || gen_random_uuid()::text, 'pfx') RETURNING id`,
    )
  ).id
}
async function mkLog(db: any, o: { user: string; key: string; status?: number; reason?: string | null; endpoint?: string; env?: string; at?: string }) {
  await db.exec(
    `INSERT INTO api_v2_logs(key_id, user_id, method, endpoint, status_code, error_reason, environment, created_at)
     VALUES ('${o.key}', '${o.user}', 'POST', ${lit(o.endpoint ?? "/api/v2/data/purchase")}, ${o.status ?? 200},
       ${lit(o.reason ?? null)}, '${o.env ?? "live"}', ${o.at ?? "now()"})`,
  )
}
async function mkOrder(db: any, o: { user: string; key: string | null; ref: string; status?: string; phone?: string; at?: string; price?: number }) {
  await db.exec(
    `INSERT INTO api_orders(user_id, api_v2_key_id, network, volume_gb, price, recipient_phone, api_reference, status, created_at)
     VALUES ('${o.user}', ${lit(o.key)}, 'MTN', 1.5, ${o.price ?? 6.5}, '${o.phone ?? "0241234567"}', '${o.ref}', '${o.status ?? "completed"}', ${o.at ?? "now()"})`,
  )
}
async function mkClaim(db: any, o: { user: string; key: string; kind: string; ref: string; status?: string; response?: object | null; at?: string; orderRef?: string }) {
  await db.exec(
    `INSERT INTO api_v2_idempotency(user_id, api_v2_key_id, kind, reference, status, order_ref, response, created_at)
     VALUES ('${o.user}', '${o.key}', '${o.kind}', '${o.ref}', '${o.status ?? "done"}', ${lit(o.orderRef ?? null)}, ${lit(o.response ?? null)}::jsonb, ${o.at ?? "now()"})`,
  )
}

describe.skipIf(!PGliteCtor)("0199 in PGlite", () => {
  it("privileges: anon/authenticated have no table or function access; service_role executes each function", async () => {
    const db = await fresh99()
    expect((await one(db, "SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.api_v2_balance_alerts'::regclass")).r).toBe(true)
    expect((await one(db, "SELECT count(*)::int AS n FROM pg_policies WHERE tablename='api_v2_balance_alerts'")).n).toBe(0)
    for (const who of ["anon", "authenticated"]) {
      expect((await one(db, `SELECT has_table_privilege('${who}', 'public.api_v2_balance_alerts', 'SELECT') AS h`)).h).toBe(false)
      for (const f of FUNCTIONS) {
        expect((await one(db, `SELECT has_function_privilege('${who}', 'public.${f}', 'EXECUTE') AS h`)).h, `${who} ${f}`).toBe(false)
      }
    }
    for (const f of FUNCTIONS) {
      expect((await one(db, `SELECT has_function_privilege('service_role', 'public.${f}', 'EXECUTE') AS h`)).h, f).toBe(true)
    }
  }, 60_000)

  it("usage counts only the person's own keys and orders; failed = status >= 400; sms claims are not orders", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const other = await mkUser(db)
    const myKey = await mkKey(db, me)
    const myTest = await mkKey(db, me, { env: "test" })
    const theirKey = await mkKey(db, other)
    await mkLog(db, { user: me, key: myKey })
    await mkLog(db, { user: me, key: myKey, status: 402, reason: "insufficient_balance" })
    await mkLog(db, { user: me, key: myTest, env: "test", status: 500, reason: "unavailable", endpoint: "/api/v2/airtime" })
    await mkLog(db, { user: other, key: theirKey, status: 400, reason: "bad" })
    await mkLog(db, { user: me, key: myKey, at: "now() - interval '40 days'" })
    await mkOrder(db, { user: me, key: myKey, ref: "d1" })
    await mkOrder(db, { user: me, key: null, ref: "v1-order" })
    await mkOrder(db, { user: other, key: theirKey, ref: "x1" })
    await mkClaim(db, { user: me, key: myKey, kind: "airtime", ref: "a1", response: { status: "completed" } })
    await mkClaim(db, { user: me, key: myKey, kind: "sms", ref: "s1" })

    const r = await call(db, "api_v2_dev_usage", me, 7, null)
    expect(r.days).toBe(7)
    expect(r.daily).toHaveLength(7)
    expect(r.daily[6]).toMatchObject({ ok: 1, failed: 2 })
    expect(r.daily.slice(0, 6).every((d: any) => d.ok === 0 && d.failed === 0)).toBe(true)
    expect(r.endpoints).toEqual([
      { endpoint: "/api/v2/data/purchase", total: 2, failed: 1 },
      { endpoint: "/api/v2/airtime", total: 1, failed: 1 },
    ])
    expect(r.reasons).toEqual([
      { reason: "insufficient_balance", count: 1 },
      { reason: "unavailable", count: 1 },
    ])
    expect(r.orders).toEqual({ data: 1, airtime: 1 })

    const live = await call(db, "api_v2_dev_usage", me, 30, "live")
    expect(live.daily).toHaveLength(30)
    expect(live.daily[29]).toMatchObject({ ok: 1, failed: 1 })
    const test = await call(db, "api_v2_dev_usage", me, 7, "test")
    expect(test.orders).toEqual({})
    expect(test.daily[6]).toMatchObject({ ok: 0, failed: 1 })
    expect((await call(db, "api_v2_dev_usage", me, 365, null)).days).toBe(7)
  }, 60_000)

  it("logs: own rows only; a foreign or malformed key filter returns nothing; status classes; 31-day window", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const other = await mkUser(db)
    const myKey = await mkKey(db, me)
    const theirKey = await mkKey(db, other)
    await mkLog(db, { user: me, key: myKey, status: 200 })
    await mkLog(db, { user: me, key: myKey, status: 404 })
    await mkLog(db, { user: me, key: myKey, status: 503 })
    await mkLog(db, { user: me, key: myKey, status: 200, at: "now() - interval '45 days'" })
    await mkLog(db, { user: other, key: theirKey, status: 200 })

    expect(await call(db, "api_v2_dev_logs", me, {}, null, null, 50)).toHaveLength(3)
    expect(await call(db, "api_v2_dev_logs", me, { key: theirKey }, null, null, 50)).toEqual([])
    expect(await call(db, "api_v2_dev_logs", me, { key: "not-a-uuid" }, null, null, 50)).toEqual([])
    expect(await call(db, "api_v2_dev_logs", other, { key: myKey }, null, null, 50)).toEqual([])
    expect((await call(db, "api_v2_dev_logs", me, { status: "ok" }, null, null, 50)).map((x: any) => x.status)).toEqual([200])
    expect((await call(db, "api_v2_dev_logs", me, { status: "client" }, null, null, 50)).map((x: any) => x.status)).toEqual([404])
    expect((await call(db, "api_v2_dev_logs", me, { status: "server" }, null, null, 50)).map((x: any) => x.status)).toEqual([503])
    const wide = await call(db, "api_v2_dev_logs", me, { from: new Date(Date.now() - 90 * 86400000).toISOString() }, null, null, 50)
    expect(wide).toHaveLength(3)
    expect(await call(db, "api_v2_dev_logs", me, { from: "yesterday-ish" }, null, null, 50)).toEqual([])
    const row = (await call(db, "api_v2_dev_logs", me, { status: "client" }, null, null, 50))[0]
    expect(Object.keys(row).sort()).toEqual(["created_at", "duration_ms", "endpoint", "environment", "id", "ip", "key_id", "method", "reason", "status"])
  }, 60_000)

  it("logs keyset paging walks rows that share one timestamp without a gap or a repeat", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const key = await mkKey(db, me)
    for (let i = 0; i < 7; i++) await mkLog(db, { user: me, key, at: "'2026-11-25T10:00:00Z'" })
    await mkLog(db, { user: me, key, at: "'2026-11-25T09:00:00Z'" })
    const seen: string[] = []
    let before: { at: string | null; id: string | null } = { at: null, id: null }
    for (let page = 0; page < 10; page++) {
      const got = await call(db, "api_v2_dev_logs", me, { to: "2026-11-25T12:00:00Z" }, before.at, before.id, 3)
      if (!got.length) break
      seen.push(...got.map((x: any) => x.id))
      const last = got[got.length - 1]
      before = { at: last.created_at, id: last.id }
    }
    expect(seen).toHaveLength(8)
    expect(new Set(seen).size).toBe(8)
  }, 60_000)

  it("orders: data + commission for the person only; reference search covers every date; filters; status mapping", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const other = await mkUser(db)
    const key = await mkKey(db, me, { type: "standard" })
    const ckey = await mkKey(db, me, { type: "commission" })
    const theirKey = await mkKey(db, other)
    await mkOrder(db, { user: me, key, ref: "d-now", status: "cancelled", phone: "0241112222" })
    await mkOrder(db, { user: me, key, ref: "d-old", at: "now() - interval '200 days'" })
    await mkOrder(db, { user: me, key: null, ref: "v1-only" })
    await mkOrder(db, { user: other, key: theirKey, ref: "d-now" })
    await mkClaim(db, { user: me, key: ckey, kind: "airtime", ref: "a-done", response: { status: "pending_payment", recipient: "0241112222", total_paid: 10.456, network: "MTN" } })
    await mkClaim(db, { user: me, key: ckey, kind: "bill", ref: "b-run", status: "in_progress" })
    await mkClaim(db, { user: me, key: ckey, kind: "bundle", ref: "u-unk", status: "unknown" })
    await mkClaim(db, { user: me, key: ckey, kind: "sms", ref: "s1", response: { status: "completed" } })

    const all = await call(db, "api_v2_dev_orders", me, {}, null, null, 50)
    expect(all.map((r: any) => `${r.product}:${r.reference}:${r.status}`).sort()).toEqual([
      "airtime:a-done:pending",
      "bill:b-run:processing",
      "bundle:u-unk:unknown",
      "data:d-now:failed",
    ])
    const airtime = all.find((r: any) => r.reference === "a-done")
    expect(airtime).toMatchObject({ recipient: "0241112222", item: "MTN" })
    expect(Number(airtime.amount)).toBe(10.46)
    expect(all.find((r: any) => r.reference === "d-now").item).toBe("MTN 1.5 GB")

    expect((await call(db, "api_v2_dev_orders", me, { reference: "d-old" }, null, null, 50)).map((r: any) => r.reference)).toEqual(["d-old"])
    expect(await call(db, "api_v2_dev_orders", me, { reference: "v1-only" }, null, null, 50)).toEqual([])
    expect((await call(db, "api_v2_dev_orders", me, { recipient: "0241112222" }, null, null, 50)).map((r: any) => r.reference).sort()).toEqual(["a-done", "d-now"])
    expect((await call(db, "api_v2_dev_orders", me, { product: "bill" }, null, null, 50)).map((r: any) => r.reference)).toEqual(["b-run"])
    expect((await call(db, "api_v2_dev_orders", me, { status: "failed" }, null, null, 50)).map((r: any) => r.reference)).toEqual(["d-now"])
    const theirs = await call(db, "api_v2_dev_orders", other, {}, null, null, 50)
    expect(theirs.map((r: any) => r.reference)).toEqual(["d-now"])
    expect(await call(db, "api_v2_dev_orders", me, { to: "garbage" }, null, null, 50)).toEqual([])
  }, 60_000)

  it("a done commission order shows the LIVE product-row status (owner-scoped), else the stored one", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const other = await mkUser(db)
    const ckey = await mkKey(db, me, { type: "commission" })
    const tables: Record<string, [string, string]> = {
      airtime: ["airtime_orders", "reference_code"],
      bill: ["hubtel_bill_orders", "reference_code"],
      bundle: ["hubtel_data_orders", "reference_code"],
      results: ["results_checker_orders", "reference_code"],
      afa: ["afa_orders", "order_code"],
    }
    for (const [kind, [table, col]] of Object.entries(tables)) {
      await db.exec(`INSERT INTO ${table}(user_id, ${col}, status) VALUES ('${me}', 'C-${kind}', 'refunded')`)
      await mkClaim(db, { user: me, key: ckey, kind, ref: `r-${kind}`, orderRef: `C-${kind}`, response: { status: "processing" } })
    }
    // someone else's live row with the code of my claim is never read
    await db.exec(`INSERT INTO airtime_orders(user_id, reference_code, status) VALUES ('${other}', 'C-theirs', 'completed')`)
    await mkClaim(db, { user: me, key: ckey, kind: "airtime", ref: "r-foreign", orderRef: "C-theirs", response: { status: "processing" } })
    // no live row: the stored status stands
    await mkClaim(db, { user: me, key: ckey, kind: "airtime", ref: "r-missing", orderRef: "C-none", response: { status: "failed" } })

    const got = await call(db, "api_v2_dev_orders", me, {}, null, null, 50)
    const st = (ref: string) => got.find((r: any) => r.reference === ref).status
    for (const kind of Object.keys(tables)) expect(st(`r-${kind}`), kind).toBe("refunded")
    expect(st("r-foreign")).toBe("processing")
    expect(st("r-missing")).toBe("failed")
    expect((await call(db, "api_v2_dev_orders", me, { status: "refunded" }, null, null, 50))).toHaveLength(5)
  }, 60_000)

  it("a half-given cursor returns nothing (logs and orders)", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const key = await mkKey(db, me)
    await mkLog(db, { user: me, key })
    await mkOrder(db, { user: me, key, ref: "d1" })
    expect(await call(db, "api_v2_dev_logs", me, {}, new Date(Date.now() + 60000).toISOString(), null, 50)).toEqual([])
    expect(await call(db, "api_v2_dev_orders", me, {}, new Date(Date.now() + 60000).toISOString(), null, 50)).toEqual([])
    expect(await call(db, "api_v2_dev_orders", me, {}, null, "data:d1", 50)).toEqual([])
  }, 60_000)

  it("orders keyset paging walks equal timestamps across products without a gap or a repeat", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const key = await mkKey(db, me)
    const ckey = await mkKey(db, me, { type: "commission" })
    for (let i = 0; i < 4; i++) await mkOrder(db, { user: me, key, ref: `d${i}`, at: "'2026-11-25T10:00:00Z'" })
    for (let i = 0; i < 3; i++) await mkClaim(db, { user: me, key: ckey, kind: "airtime", ref: `a${i}`, response: {}, at: "'2026-11-25T10:00:00Z'" })
    const seen: string[] = []
    let before: { at: string | null; key: string | null } = { at: null, key: null }
    for (let page = 0; page < 10; page++) {
      const got = await call(db, "api_v2_dev_orders", me, { to: "2026-11-25T12:00:00Z" }, before.at, before.key, 2)
      if (!got.length) break
      seen.push(...got.map((x: any) => `${x.product}:${x.reference}`))
      const last = got[got.length - 1]
      before = { at: last.created_at, key: `${last.product}:${last.reference}` }
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  }, 60_000)

  it("the SQL public statuses match mapOrderStatus and mapCommissionStatus", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const key = await mkKey(db, me)
    const ckey = await mkKey(db, me, { type: "commission" })
    const raw = ["pending", "processing", "completed", "failed", "refunded", "cancelled", "held_registration", "reversed", "refunding", "pending_payment", "weird", ""]
    for (const s of raw) {
      await mkOrder(db, { user: me, key, ref: `d-${s || "empty"}`, status: s })
      await mkClaim(db, { user: me, key: ckey, kind: "airtime", ref: `a-${s || "empty"}`, response: { status: s } })
    }
    const got = await call(db, "api_v2_dev_orders", me, {}, null, null, 100)
    for (const s of raw) {
      expect(got.find((r: any) => r.reference === `d-${s || "empty"}`).status, `data ${s}`).toBe(mapOrderStatus(s))
      expect(got.find((r: any) => r.reference === `a-${s || "empty"}`).status, `airtime ${s}`).toBe(mapCommissionStatus(s))
    }
  }, 60_000)

  it("balance alert: validates, fires once per crossing, re-arms when the balance recovers, removes", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const other = await mkUser(db)
    await db.exec(`INSERT INTO wallets(user_id, balance) VALUES ('${me}', 100), ('${other}', 5)`)
    await expect(call(db, "api_v2_set_balance_alert", me, 0)).rejects.toThrow(/out of range/)
    await expect(call(db, "api_v2_set_balance_alert", me, 100001)).rejects.toThrow(/out of range/)
    await expect(call(db, "api_v2_set_balance_alert", me, 10.005)).rejects.toThrow(/out of range/)
    expect(await call(db, "api_v2_set_balance_alert", me, 50)).toMatchObject({ armed: true, enabled: true })
    expect((await call(db, "api_v2_get_balance_alert", me)).alert).toMatchObject({ armed: true })
    expect(Number((await call(db, "api_v2_get_balance_alert", me)).balance)).toBe(100)
    expect((await call(db, "api_v2_get_balance_alert", other)).alert).toBeNull()

    expect(await call(db, "api_v2_balance_alert_scan", null)).toEqual([])
    await db.exec(`UPDATE wallets SET balance = 20 WHERE user_id = '${me}'`)
    const fired = await call(db, "api_v2_balance_alert_scan", null)
    expect(fired).toHaveLength(1)
    expect(fired[0].user_id).toBe(me)
    expect(Number(fired[0].balance)).toBe(20)
    expect(await call(db, "api_v2_balance_alert_scan", null)).toEqual([])
    await db.exec(`UPDATE wallets SET balance = 10 WHERE user_id = '${me}'`)
    expect(await call(db, "api_v2_balance_alert_scan", null)).toEqual([])
    await db.exec(`UPDATE wallets SET balance = 60 WHERE user_id = '${me}'`)
    expect(await call(db, "api_v2_balance_alert_scan", null)).toEqual([])
    expect((await call(db, "api_v2_get_balance_alert", me)).alert.armed).toBe(true)
    await db.exec(`UPDATE wallets SET balance = 49.99 WHERE user_id = '${me}'`)
    expect(await call(db, "api_v2_balance_alert_scan", null)).toHaveLength(1)

    expect(await call(db, "api_v2_set_balance_alert", me, null)).toEqual({ removed: true })
    expect((await call(db, "api_v2_get_balance_alert", me)).alert).toBeNull()
  }, 60_000)

  it("retention deletes only rows older than 25 months", async () => {
    const db = await fresh99()
    const me = await mkUser(db)
    const key = await mkKey(db, me)
    await mkLog(db, { user: me, key, at: "now() - interval '26 months'" })
    await mkLog(db, { user: me, key, at: "now() - interval '24 months'" })
    await mkLog(db, { user: me, key })
    expect(await call(db, "api_v2_logs_retention", null)).toBe(1)
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_logs")).n).toBe(2)
    expect(await call(db, "api_v2_logs_retention", null)).toBe(0)
  }, 60_000)

  it("the dry-run string raises SELFTEST_OK 0199 and leaves nothing behind", async () => {
    const db = new PGliteCtor()
    opened.push(db)
    await db.exec(ROLES)
    await db.exec(STUBS)
    await db.exec(read("0128_api_v2_foundation.sql"))
    await db.exec(STUBS_AFTER)
    const run = buildRunString(migration(), read(SELFTEST_FILE))
    await expect(db.exec(run)).rejects.toThrow(/SELFTEST_OK 0199/)
    await db.exec("ROLLBACK").catch(() => undefined)
    expect((await one(db, "SELECT to_regclass('public.api_v2_balance_alerts') AS t")).t).toBeNull()
  }, 60_000)
})
