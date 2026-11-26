// lib/api-v2/migration-0200.test.ts
// migrations/0200_api_webhooks.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0200 reads 0128 (api_v2_keys, loaded for real) plus stubs shaped as production has them: api_orders, api_v2_idempotency
// and the five commission product tables.
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0200-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0200_api_webhooks.sql"
const SELFTEST_FILE = "0200_api_webhooks.selftest.sql"
const migration = () => read(FILE)

const FUNCTIONS = [
  "api_v2_webhook_orders(uuid,timestamptz)",
  "api_v2_webhook_get(uuid)",
  "api_v2_webhook_set_endpoint(uuid,text,boolean,text)",
  "api_v2_webhook_rotate_secret(uuid,text)",
  "api_v2_webhook_reveal(uuid)",
  "api_v2_webhook_delete_endpoint(uuid)",
  "api_v2_webhook_scan(timestamptz,integer)",
  "api_v2_webhook_claim(timestamptz,integer)",
  "api_v2_webhook_claim_one(uuid,text,timestamptz)",
  "api_v2_webhook_record(text,integer,boolean,integer,integer,text,text,timestamptz)",
  "api_v2_webhook_enqueue_test(uuid,timestamptz)",
  "api_v2_webhook_resend(uuid,text,timestamptz)",
  "api_v2_webhook_deliveries(uuid,timestamptz,text,integer)",
  "api_v2_webhook_settings_get(timestamptz)",
  "api_v2_webhook_settings_set(boolean,uuid)",
  "api_v2_webhook_retention(timestamptz)",
]
const TABLES = ["api_v2_webhook_settings", "api_v2_webhook_endpoints", "api_v2_webhook_state", "api_v2_webhook_events", "api_v2_webhook_attempts"]

describe("0200 migration text", () => {
  it("one BEGIN, both SET LOCALs, one COMMIT; run string ends RAISE 'SELFTEST_OK 0200' and has no COMMIT", () => {
    const c = code(migration())
    expect(c.match(/^BEGIN;\s*$/gm)).toHaveLength(1)
    expect(c).toMatch(/SET LOCAL lock_timeout = '2s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '15s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0200';\s*END\s*\$selftest\$;$/)
    expect(() => buildRunString(migration().replace(/^COMMIT;$/m, ""), read(SELFTEST_FILE))).toThrow(/0200:no COMMIT/)
  })

  it("header has PRE-CHECKS and VERIFY; nothing altered or indexed on an existing table; no foreign key", () => {
    const m = migration()
    const header = m.slice(0, m.indexOf("\nBEGIN;"))
    expect(header).toContain("PRE-CHECKS")
    expect(header).toContain("VERIFY")
    const c = code(m)
    expect(c).not.toMatch(/ALTER TABLE\s+(IF EXISTS\s+)?(ONLY\s+)?(?!(public\.)?api_v2_webhook_)[\w.]+/i)
    for (const ix of c.match(/CREATE\s+(UNIQUE\s+)?INDEX[^;]*;/gi) ?? []) expect(ix).toMatch(/ON public\.api_v2_webhook_/)
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
  CREATE TABLE public.api_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, api_key_id uuid, api_v2_key_id uuid,
    package_id uuid, network text, volume_gb numeric, price numeric, recipient_phone text, api_reference text, status text,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.api_v2_idempotency(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, api_v2_key_id uuid NOT NULL,
    kind text NOT NULL, reference text NOT NULL, request_hash text NOT NULL DEFAULT repeat('a', 64), status text NOT NULL DEFAULT 'in_progress',
    order_ref text, response jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE (user_id, kind, reference));
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
async function fresh(): Promise<any> {
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
  x === null || x === undefined
    ? "NULL"
    : typeof x === "number" || typeof x === "boolean"
      ? String(x)
      : `'${String(typeof x === "object" ? JSON.stringify(x) : x).replace(/'/g, "''")}'`
async function call(db: any, fn: string, ...args: unknown[]): Promise<any> {
  return (await one(db, `SELECT public.${fn}(${args.map(lit).join(", ")}) AS r`)).r
}
const SECRET = "whsec_" + "A".repeat(43)
const SECRET2 = "whsec_" + "B".repeat(43)
async function mkUser(db: any): Promise<string> {
  const id = (await one(db, "SELECT gen_random_uuid() AS id")).id
  await db.exec(`INSERT INTO auth.users(id) VALUES ('${id}')`)
  return id
}
async function mkKey(db: any, user: string): Promise<string> {
  return (
    await one(
      db,
      `INSERT INTO api_v2_keys(user_id, key_type, environment, status, name, key_hash, key_prefix)
       VALUES ('${user}', 'standard', 'live', 'active', 'k', 'h-' || gen_random_uuid()::text, 'pfx') RETURNING id`,
    )
  ).id
}
async function mkOrder(db: any, o: { user: string; key: string | null; ref: string; status?: string; at?: string }) {
  await db.exec(
    `INSERT INTO api_orders(user_id, api_v2_key_id, network, volume_gb, price, recipient_phone, api_reference, status, created_at)
     VALUES ('${o.user}', ${lit(o.key)}, 'MTN', 1.5, 6.5, '0241234567', '${o.ref}', '${o.status ?? "completed"}', ${o.at ?? "now()"})`,
  )
}
const setOrder = (db: any, ref: string, status: string) => db.exec(`UPDATE api_orders SET status = '${status}' WHERE api_reference = '${ref}'`)
async function setup(db: any, o: { on?: boolean; endpointAt?: string } = {}) {
  if (o.on !== false) await db.exec("UPDATE api_v2_webhook_settings SET enabled = true WHERE id = 1")
  const user = await mkUser(db)
  const key = await mkKey(db, user)
  await call(db, "api_v2_webhook_set_endpoint", user, "https://hooks.example.com/dg", true, SECRET)
  await db.exec(`UPDATE api_v2_webhook_endpoints SET created_at = ${o.endpointAt ?? "now() - interval '1 hour'"} WHERE user_id = '${user}'`)
  return { user, key }
}
const scan = (db: any) => call(db, "api_v2_webhook_scan", null, 500)
const events = (db: any, user: string) => rows(db, `SELECT * FROM api_v2_webhook_events WHERE user_id = '${user}' ORDER BY created_at, id`)

describe.skipIf(!PGliteCtor)("0200 in PGlite", () => {
  it("privileges: RLS on with no policies; anon/authenticated have no access; service_role executes each function", async () => {
    const db = await fresh()
    for (const t of TABLES) {
      expect((await one(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.${t}'::regclass`)).r, t).toBe(true)
      for (const who of ["anon", "authenticated"]) {
        expect((await one(db, `SELECT has_table_privilege('${who}', 'public.${t}', 'SELECT') AS h`)).h, `${who} ${t}`).toBe(false)
      }
    }
    expect((await one(db, "SELECT count(*)::int AS n FROM pg_policies WHERE tablename LIKE 'api_v2_webhook_%'")).n).toBe(0)
    for (const f of FUNCTIONS) {
      for (const who of ["anon", "authenticated"]) {
        expect((await one(db, `SELECT has_function_privilege('${who}', 'public.${f}', 'EXECUTE') AS h`)).h, `${who} ${f}`).toBe(false)
      }
      expect((await one(db, `SELECT has_function_privilege('service_role', 'public.${f}', 'EXECUTE') AS h`)).h, f).toBe(true)
    }
    expect((await one(db, "SELECT enabled FROM api_v2_webhook_settings WHERE id = 1")).enabled).toBe(false)
  }, 60_000)

  it("switch off: scan creates nothing and claim returns nothing, even with an endpoint and due events", async () => {
    const db = await fresh()
    const { user, key } = await setup(db, { on: false })
    await mkOrder(db, { user, key, ref: "R-OFF" })
    expect(await scan(db)).toBe(0)
    await db.exec(`INSERT INTO api_v2_webhook_events(id, user_id, type, payload) VALUES ('evt_${"0".repeat(24)}', '${user}', 'order.updated', '{}')`)
    expect(await call(db, "api_v2_webhook_claim", null, 50)).toEqual([])
    expect((await call(db, "api_v2_webhook_enqueue_test", user, null)).error).toBe("disabled")
  }, 60_000)

  it("scan: one event per final status change; nothing for pending/processing, other people, pre-endpoint or >7 day orders", async () => {
    const db = await fresh()
    const { user, key } = await setup(db)
    const other = await mkUser(db)
    const otherKey = await mkKey(db, other)
    await mkOrder(db, { user, key, ref: "R-PENDING", status: "pending" })
    await mkOrder(db, { user, key, ref: "R-DONE", status: "completed" })
    await mkOrder(db, { user, key, ref: "R-BEFORE", status: "completed", at: "now() - interval '2 hours'" })
    await mkOrder(db, { user, key: null, ref: "R-V1", status: "completed" })
    await mkOrder(db, { user: other, key: otherKey, ref: "R-OTHER", status: "completed" })
    expect(await scan(db)).toBe(1)
    let ev = await events(db, user)
    expect(ev).toHaveLength(1)
    expect(ev[0].id).toMatch(/^evt_[0-9a-f]{24}$/)
    expect(ev[0].type).toBe("order.updated")
    expect(ev[0].state).toBe("pending")
    expect(ev[0].payload).toMatchObject({ id: ev[0].id, type: "order.updated", livemode: true })
    expect(ev[0].payload.data).toMatchObject({ product: "data", reference: "R-DONE", status: "completed", previous_status: null, recipient: "0241234567", item: "MTN 1.5 GB" })
    expect(Number(ev[0].payload.data.amount)).toBe(6.5)
    expect(await scan(db)).toBe(0)
    await setOrder(db, "R-PENDING", "processing")
    expect(await scan(db)).toBe(0)
    await setOrder(db, "R-DONE", "failed")
    await setOrder(db, "R-PENDING", "completed")
    expect(await scan(db)).toBe(2)
    ev = await events(db, user)
    const byRef = Object.fromEntries(ev.slice(1).map((e: any) => [e.payload.data.reference, e.payload.data]))
    expect(byRef["R-DONE"]).toMatchObject({ status: "failed", previous_status: "completed" })
    expect(byRef["R-PENDING"]).toMatchObject({ status: "completed", previous_status: null })
    // a reversal shown as processing is not a final status: nothing new
    await setOrder(db, "R-DONE", "reversed")
    expect(await scan(db)).toBe(0)
    // older than seven days is never scanned, even if the endpoint is older still
    await db.exec(`UPDATE api_v2_webhook_endpoints SET created_at = now() - interval '30 days' WHERE user_id = '${user}'`)
    await mkOrder(db, { user, key, ref: "R-OLD", status: "completed", at: "now() - interval '8 days'" })
    expect(await scan(db)).toBe(1) // R-BEFORE (2 h old) is now after the endpoint; R-OLD is not
    expect((await events(db, user)).map((e: any) => e.payload.data.reference)).not.toContain("R-OLD")
    // a disabled endpoint is not scanned
    await call(db, "api_v2_webhook_set_endpoint", user, "https://hooks.example.com/dg", false, null)
    await setOrder(db, "R-PENDING", "refunded")
    expect(await scan(db)).toBe(0)
  }, 60_000)

  it("scan reads commission status live from the product table by order_ref", async () => {
    const db = await fresh()
    const { user, key } = await setup(db)
    await db.exec(`INSERT INTO airtime_orders(user_id, reference_code, status) VALUES ('${user}', 'AIR-1', 'pending')`)
    await db.exec(
      `INSERT INTO api_v2_idempotency(user_id, api_v2_key_id, kind, reference, status, order_ref, response)
       VALUES ('${user}', '${key}', 'airtime', 'MY-AIR', 'done', 'AIR-1', '{"status":"pending","network":"MTN","recipient":"0241112222","amount":5}')`,
    )
    expect(await scan(db)).toBe(0)
    await db.exec("UPDATE airtime_orders SET status = 'completed' WHERE reference_code = 'AIR-1'")
    expect(await scan(db)).toBe(1)
    const [ev] = await events(db, user)
    expect(ev.payload.data).toMatchObject({ product: "airtime", reference: "MY-AIR", status: "completed", recipient: "0241112222", item: "MTN" })
  }, 60_000)

  it("claim: leases due events with url and secret, caps 10 per person, then record follows the retry schedule", async () => {
    const db = await fresh()
    const { user, key } = await setup(db)
    for (let i = 0; i < 12; i++) await mkOrder(db, { user, key, ref: `R-${i}` })
    expect(await scan(db)).toBe(12)
    const batch = await call(db, "api_v2_webhook_claim", null, 50)
    expect(batch).toHaveLength(10)
    expect(batch[0]).toMatchObject({ user_id: user, type: "order.updated", attempt: 1, url: "https://hooks.example.com/dg", secret: SECRET })
    expect(batch[0].payload.data.reference).toMatch(/^R-/)
    // leased: claimed again at once, only the two left over come back
    expect(await call(db, "api_v2_webhook_claim", null, 50)).toHaveLength(2)
    const id = batch[0].id
    const r1 = await call(db, "api_v2_webhook_record", id, 1, false, 500, 12, "HTTP 500", "oops", null)
    expect(r1).toMatchObject({ state: "pending" })
    const ev = await one(db, `SELECT *, round(extract(epoch FROM next_attempt_at - now())) AS wait FROM api_v2_webhook_events WHERE id = '${id}'`)
    expect(Number(ev.wait)).toBe(60)
    expect(ev.last_code).toBe(500)
    const waits = [300, 1800, 7200, 28800, 86400]
    for (let n = 2; n <= 6; n++) {
      await db.exec(`UPDATE api_v2_webhook_events SET next_attempt_at = now() - interval '1 second' WHERE id = '${id}'`)
      const c = (await call(db, "api_v2_webhook_claim", null, 50)).find((x: any) => x.id === id)
      expect(c.attempt).toBe(n)
      await call(db, "api_v2_webhook_record", id, n, false, null, 10000, "timeout", null, null)
      const w = await one(db, `SELECT round(extract(epoch FROM next_attempt_at - now())) AS wait FROM api_v2_webhook_events WHERE id = '${id}'`)
      expect(Number(w.wait)).toBe(waits[n - 2])
    }
    await db.exec(`UPDATE api_v2_webhook_events SET next_attempt_at = now() - interval '1 second' WHERE id = '${id}'`)
    expect((await call(db, "api_v2_webhook_claim", null, 50)).find((x: any) => x.id === id).attempt).toBe(7)
    expect(await call(db, "api_v2_webhook_record", id, 7, false, 502, 5, "HTTP 502", null, null)).toMatchObject({ state: "failed" })
    expect((await one(db, `SELECT count(*)::int AS n FROM api_v2_webhook_attempts WHERE event_id = '${id}'`)).n).toBe(7)
    // success
    const ok = batch[1].id
    expect(await call(db, "api_v2_webhook_record", ok, 1, true, 200, 80, null, "ok", null)).toMatchObject({ state: "delivered" })
    expect((await one(db, `SELECT delivered_at IS NOT NULL AS d FROM api_v2_webhook_events WHERE id = '${ok}'`)).d).toBe(true)
  }, 60_000)

  it("a late record from an expired lease does not overwrite the newer attempt", async () => {
    const db = await fresh()
    const { user, key } = await setup(db)
    await mkOrder(db, { user, key, ref: "R-LATE" })
    await scan(db)
    const [first] = await call(db, "api_v2_webhook_claim", null, 50)
    await db.exec(`UPDATE api_v2_webhook_events SET next_attempt_at = now() - interval '1 second' WHERE id = '${first.id}'`)
    const [second] = await call(db, "api_v2_webhook_claim", null, 50)
    expect(second.attempt).toBe(2)
    expect(await call(db, "api_v2_webhook_record", first.id, 1, true, 200, 5, null, null, null)).toMatchObject({ stale: true })
    expect((await one(db, `SELECT state FROM api_v2_webhook_events WHERE id = '${first.id}'`)).state).toBe("pending")
    expect(await call(db, "api_v2_webhook_record", first.id, 2, true, 200, 5, null, null, null)).toMatchObject({ state: "delivered" })
  }, 60_000)

  it("test event: enqueued for the caller, claimed by id only by its owner, one attempt only", async () => {
    const db = await fresh()
    const { user } = await setup(db)
    const stranger = await mkUser(db)
    expect((await call(db, "api_v2_webhook_enqueue_test", stranger, null)).error).toBe("no_endpoint")
    const { id } = await call(db, "api_v2_webhook_enqueue_test", user, null)
    expect(id).toMatch(/^evt_/)
    expect(await call(db, "api_v2_webhook_claim_one", stranger, id, null)).toBeNull()
    const job = await call(db, "api_v2_webhook_claim_one", user, id, null)
    expect(job).toMatchObject({ id, type: "webhook.test", attempt: 1, secret: SECRET })
    expect(job.payload).toMatchObject({ type: "webhook.test", test: true })
    expect(await call(db, "api_v2_webhook_record", id, 1, false, 404, 3, "HTTP 404", null, null)).toMatchObject({ state: "failed" })
  }, 60_000)

  it("resend re-queues own delivered/failed events only; delete endpoint fails pending events and clears state", async () => {
    const db = await fresh()
    const { user, key } = await setup(db)
    const stranger = await mkUser(db)
    await mkOrder(db, { user, key, ref: "R-A" })
    await mkOrder(db, { user, key, ref: "R-B" })
    await scan(db)
    const [a] = await call(db, "api_v2_webhook_claim", null, 1)
    expect((await call(db, "api_v2_webhook_resend", user, a.id, null)).error).toBe("pending")
    await call(db, "api_v2_webhook_record", a.id, 1, true, 200, 5, null, null, null)
    expect((await call(db, "api_v2_webhook_resend", stranger, a.id, null)).error).toBe("not_found")
    expect(await call(db, "api_v2_webhook_resend", user, a.id, null)).toMatchObject({ ok: true })
    expect(await one(db, `SELECT state, attempts FROM api_v2_webhook_events WHERE id = '${a.id}'`)).toEqual({ state: "pending", attempts: 0 })
    expect(await call(db, "api_v2_webhook_delete_endpoint", user)).toMatchObject({ removed: true })
    expect((await rows(db, `SELECT state FROM api_v2_webhook_events WHERE user_id = '${user}'`)).every((r: any) => r.state === "failed")).toBe(true)
    expect((await one(db, `SELECT count(*)::int AS n FROM api_v2_webhook_state WHERE user_id = '${user}'`)).n).toBe(0)
    expect(await call(db, "api_v2_webhook_get", user)).toMatchObject({ endpoint: null })
  }, 60_000)

  it("endpoint: https backstop, secret kept on edit, reveal and rotate, hint shows the last four only", async () => {
    const db = await fresh()
    const user = await mkUser(db)
    await expect(call(db, "api_v2_webhook_set_endpoint", user, "http://x.example.com/h", true, SECRET)).rejects.toThrow()
    await expect(call(db, "api_v2_webhook_set_endpoint", user, "https://x.example.com/h", true, null)).rejects.toThrow()
    const created = await call(db, "api_v2_webhook_set_endpoint", user, "https://x.example.com/h", true, SECRET)
    expect(created).toMatchObject({ created: true, endpoint: { url: "https://x.example.com/h", enabled: true, secret_hint: "AAAA" } })
    expect(JSON.stringify(created)).not.toContain(SECRET)
    const edited = await call(db, "api_v2_webhook_set_endpoint", user, "https://y.example.com/h", false, SECRET2)
    expect(edited).toMatchObject({ created: false, endpoint: { url: "https://y.example.com/h", enabled: false } })
    expect(await call(db, "api_v2_webhook_reveal", user)).toBe(SECRET)
    expect(await call(db, "api_v2_webhook_rotate_secret", user, SECRET2)).toMatchObject({ endpoint: { secret_hint: "BBBB" } })
    expect(await call(db, "api_v2_webhook_reveal", user)).toBe(SECRET2)
    const g = await call(db, "api_v2_webhook_get", user)
    expect(g).toMatchObject({ enabled_globally: false, endpoint: { url: "https://y.example.com/h" } })
    expect(JSON.stringify(g)).not.toContain(SECRET2)
  }, 60_000)

  it("deliveries: own events newest first with attempts, keyset paging", async () => {
    const db = await fresh()
    const { user, key } = await setup(db)
    const stranger = await mkUser(db)
    for (let i = 0; i < 3; i++) await mkOrder(db, { user, key, ref: `R-${i}`, at: `now() - interval '${10 - i} minutes'` })
    await scan(db)
    await db.exec(`UPDATE api_v2_webhook_events SET created_at = (payload->'data'->>'order_created_at')::timestamptz WHERE user_id = '${user}'`)
    const [job] = await call(db, "api_v2_webhook_claim", null, 1)
    await call(db, "api_v2_webhook_record", job.id, 1, false, 500, 9, "HTTP 500", "x", null)
    const page = await call(db, "api_v2_webhook_deliveries", user, null, null, 2)
    expect(page).toHaveLength(2)
    expect(page[0].payload.data.reference).toBe("R-2")
    const rest = await call(db, "api_v2_webhook_deliveries", user, page[1].created_at, page[1].id, 2)
    expect(rest.map((e: any) => e.payload.data.reference)).toEqual(["R-0"])
    const all = [...page, ...rest]
    const tried = all.find((e: any) => e.id === job.id)
    expect(tried.attempts_log).toHaveLength(1)
    expect(tried.attempts_log[0]).toMatchObject({ ok: false, code: 500, error: "HTTP 500" })
    expect(await call(db, "api_v2_webhook_deliveries", stranger, null, null, 50)).toEqual([])
    expect(await call(db, "api_v2_webhook_deliveries", user, page[1].created_at, null, 2)).toEqual([])
  }, 60_000)

  it("settings: set needs an actor; get counts today's events by state", async () => {
    const db = await fresh()
    const actor = await mkUser(db)
    await expect(call(db, "api_v2_webhook_settings_set", true, null)).rejects.toThrow()
    expect(await call(db, "api_v2_webhook_settings_set", true, actor)).toMatchObject({ changed: true })
    expect(await call(db, "api_v2_webhook_settings_set", true, actor)).toMatchObject({ changed: false })
    const { user, key } = await setup(db)
    await mkOrder(db, { user, key, ref: "R-S" })
    await scan(db)
    expect(await call(db, "api_v2_webhook_settings_get", null)).toMatchObject({ enabled: true, endpoints: 1, today: { pending: 1, delivered: 0, failed: 0 } })
  }, 60_000)

  it("retention removes events and attempts older than 30 days and state older than 8 days", async () => {
    const db = await fresh()
    const { user, key } = await setup(db)
    await mkOrder(db, { user, key, ref: "R-OLD" })
    await mkOrder(db, { user, key, ref: "R-NEW" })
    await scan(db)
    const [job] = await call(db, "api_v2_webhook_claim", null, 1)
    await call(db, "api_v2_webhook_record", job.id, 1, true, 200, 5, null, null, null)
    await db.exec(`UPDATE api_v2_webhook_events SET created_at = now() - interval '31 days' WHERE id = '${job.id}'`)
    await db.exec(`UPDATE api_v2_webhook_state SET updated_at = now() - interval '9 days' WHERE reference = '${job.payload.data.reference}'`)
    expect(await call(db, "api_v2_webhook_retention", null)).toMatchObject({ events: 1, state: 1 })
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_webhook_events")).n).toBe(1)
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_webhook_attempts")).n).toBe(0)
  }, 60_000)

  it("the self-test passes and rolls back", async () => {
    const db = new PGliteCtor()
    opened.push(db)
    await db.exec(ROLES)
    await db.exec(STUBS)
    await db.exec(read("0128_api_v2_foundation.sql"))
    await db.exec(STUBS_AFTER)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/SELFTEST_OK 0200/)
    await db.exec("ROLLBACK").catch(() => undefined)
    expect((await one(db, "SELECT to_regclass('public.api_v2_webhook_events') AS r")).r).toBeNull()
  }, 60_000)
})
