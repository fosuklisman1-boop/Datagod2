// lib/api-v2/migration-0196.test.ts
// migrations/0196_api_admin_console.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0196 builds on 0128 (api_v2_keys, api_v2_logs, api_v2_config, loaded for real), 0131 (api_v2_admin_stats and api_v2_key_activity,
// loaded for real), 0195 (api_v2_access_grants, stubbed) and the admin_audit_log of 0069 + 0176 (stubbed).
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0196-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0196_api_admin_console.sql"
const SELFTEST_FILE = "0196_api_admin_console.selftest.sql"
const migration = () => read(FILE)

const FUNCTIONS = [
  "api_v2_set_developer_pause(uuid,boolean,text,uuid)",
  "api_v2_set_service_pause(text,boolean,text,uuid)",
  "api_v2_announcement_save(uuid,text,text,text,timestamptz,timestamptz,uuid)",
  "api_v2_announcement_delete(uuid,uuid)",
  "api_v2_developers(timestamptz,text,integer,integer)",
  "api_v2_developer_profile(uuid,timestamptz)",
  "api_v2_overview_trend(timestamptz)",
  "api_v2_business_report(timestamptz,timestamptz)",
  "api_v2_public_health(timestamptz)",
]
const TABLES = ["api_v2_developer_pauses", "api_v2_service_controls", "api_v2_announcements"]
const SERVICES = ["data", "airtime", "bills", "bundles", "results", "afa", "sms"]

describe("0196 migration text", () => {
  it("text: one BEGIN, both SET LOCALs, one COMMIT, no txn-ending statement outside function bodies; run string ends RAISE 'SELFTEST_OK 0196' and has no COMMIT", () => {
    const c = code(migration())
    expect(c.match(/^BEGIN;\s*$/gm)).toHaveLength(1)
    expect(c).toMatch(/SET LOCAL lock_timeout = '2s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '15s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
    // no txn-ending statement outside dollar-quoted bodies (the builder asserts this too; here it must simply not throw)
    const run = buildRunString(migration(), read(SELFTEST_FILE))
    const s = code(run)
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0196';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
    // the builder refuses a migration without its COMMIT line, and a self-test that could end the transaction
    expect(() => buildRunString(migration().replace(/^COMMIT;$/m, ""), read(SELFTEST_FILE))).toThrow(/0196:no COMMIT/)
    expect(() => buildRunString(migration(), read(SELFTEST_FILE).replace("DO $selftest$", "DO $selftest$ -- x\nDECLARE v int; BEGIN ROLLBACK; END; $selftest$;\nDO $selftest$"))).toThrow(/0196:/)
  })

  it("text: header lists pre-checks, verify queries, every lock, 'quiet window', harmless lock timeout; no ALTER of api_v2_keys/api_v2_logs/api_v2_config/api_orders", () => {
    const m = migration()
    const header = m.slice(0, m.indexOf("\nBEGIN;"))
    expect(header).toContain("PRE-CHECKS")
    expect(header).toContain("VERIFY")
    expect(header).toMatch(/to_regclass\('public\.api_v2_developer_pauses'\)/)
    expect(header).toMatch(/to_regclass\('public\.api_v2_access_grants'\)[^\n]*NOT NULL/)
    expect(header).toMatch(/has_function_privilege\('authenticated'[^\n]*false[^\n]*true|false, true/)
    expect(header).toMatch(/LOCKS[\s\S]*auth\.users[^\n]*SHARE ROW EXCLUSIVE/)
    expect(header).toMatch(/until the transaction ends/i)
    expect(header).toMatch(/quiet window/)
    expect(header).toMatch(/lock timeout[^\n]*(harmless|safe)[^\n]*retry/i)
    const c = code(m)
    expect(c).not.toMatch(/ALTER TABLE\s+(IF EXISTS\s+)?(ONLY\s+)?(public\.)?(api_v2_keys|api_v2_logs|api_v2_config|api_orders)\b/i)
    // the auth.users foreign key is created last among the tables, and no function needs a table at create time
    expect(c.indexOf("CREATE TABLE IF NOT EXISTS public.api_v2_developer_pauses")).toBeGreaterThan(c.indexOf("CREATE TABLE IF NOT EXISTS public.api_v2_announcements"))
    expect(c.indexOf("CREATE TABLE IF NOT EXISTS public.api_v2_developer_pauses")).toBeGreaterThan(c.lastIndexOf("CREATE OR REPLACE FUNCTION"))
    expect(c).not.toMatch(/%ROWTYPE/)
  })

  it("every function is SECURITY DEFINER with a pinned search_path and revoked from PUBLIC, anon, authenticated", () => {
    const c = code(migration())
    expect((c.match(/SECURITY DEFINER/g) ?? []).length).toBe(9)
    expect((c.match(/SET search_path = public, pg_temp/g) ?? []).length).toBe(9)
    expect((c.match(/FROM PUBLIC, anon, authenticated/g) ?? []).length).toBeGreaterThanOrEqual(9 + 3)
    expect(c).not.toMatch(/\bFOR\s+UPDATE\b/)
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
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`
// auth.users with a real FK target; public.users with the columns 0196 reads; admin_audit_log as 0069 + 0176 leave it;
// the order tables as far as 0196 reads them.
const STUBS = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE TABLE public.users(id uuid PRIMARY KEY REFERENCES auth.users(id), first_name text, last_name text, email text, role text,
    is_suspended boolean NOT NULL DEFAULT false);
  CREATE TABLE public.admin_audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid, action text NOT NULL,
    target_user_id uuid, old_value jsonb, new_value jsonb, created_at timestamptz NOT NULL DEFAULT now());
`
const STUBS_ORDERS = `
  CREATE TABLE public.packages(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.package_costs(package_id uuid PRIMARY KEY REFERENCES public.packages(id) ON DELETE CASCADE,
    cost_price numeric(10,2) NOT NULL CHECK (cost_price >= 0), updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
  CREATE TABLE public.api_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, api_key_id uuid, api_v2_key_id uuid REFERENCES public.api_v2_keys(id),
    package_id uuid, network text, volume_gb numeric, price numeric, recipient_phone text, api_reference text, status text,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.api_v2_access_grants(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, granted_by uuid,
    granted_at timestamptz NOT NULL DEFAULT now(), request_id uuid);
  CREATE TABLE public.api_v2_idempotency(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, kind text, status text,
    response jsonb, created_at timestamptz NOT NULL DEFAULT now());
`
const opened: any[] = []
afterEach(async () => {
  // each PGlite is a WASM instance with its own memory: close them so a long file cannot exhaust the worker
  while (opened.length) await opened.pop().close().catch(() => undefined)
})
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  opened.push(db)
  await db.exec(ROLES)
  await db.exec(STUBS)
  await db.exec(read("0128_api_v2_foundation.sql"))
  await db.exec(STUBS_ORDERS) // after 0128: api_orders references api_v2_keys
  await db.exec(read("0131_api_v2_stats_orders.sql"))
  return db
}
async function fresh96(): Promise<any> {
  const db = await fresh()
  await db.exec(migration())
  return db
}

const ACTOR = "00000000-0000-0000-0000-0000000000a1"

async function rows(db: any, sql: string): Promise<any[]> {
  return (await db.query(sql)).rows
}
async function one(db: any, sql: string): Promise<any> {
  return (await rows(db, sql))[0]
}
async function mkUser(db: any, o: { first?: string; last?: string; email?: string; role?: string } = {}): Promise<string> {
  const id = (await one(db, "SELECT gen_random_uuid() AS id")).id
  await db.exec(`INSERT INTO auth.users(id) VALUES ('${id}')`)
  const q = (s: string | undefined) => (s === undefined ? "NULL" : `'${s.replace(/'/g, "''")}'`)
  await db.exec(
    `INSERT INTO public.users(id, first_name, last_name, email, role) VALUES ('${id}', ${q(o.first ?? "Ama")}, ${q(o.last ?? "Mensah")}, ${q(o.email ?? `u-${id}@example.test`)}, '${o.role ?? "dealer"}')`,
  )
  return id
}
async function mkKey(db: any, user: string, o: { status?: string; type?: string; env?: string } = {}): Promise<string> {
  return (
    await one(
      db,
      `INSERT INTO api_v2_keys(user_id, key_type, environment, status, name, key_hash, key_prefix)
       VALUES ('${user}', '${o.type ?? "standard"}', '${o.env ?? "live"}', '${o.status ?? "active"}', 'k', 'h-' || gen_random_uuid()::text, 'pfx') RETURNING id`,
    )
  ).id
}
async function mkLog(db: any, key: string, user: string, status: number, o: { endpoint?: string; env?: string; at?: string } = {}): Promise<void> {
  await db.exec(
    `INSERT INTO api_v2_logs(key_id, user_id, method, endpoint, status_code, environment, created_at)
     VALUES ('${key}', '${user}', 'POST', '${o.endpoint ?? "/api/v2/data/orders"}', ${status}, '${o.env ?? "live"}', ${o.at ?? "now()"})`,
  )
}
async function mkPkg(db: any, cost?: number): Promise<string> {
  const id = (await one(db, "INSERT INTO packages DEFAULT VALUES RETURNING id")).id
  if (cost !== undefined) await db.exec(`INSERT INTO package_costs(package_id, cost_price) VALUES ('${id}', ${cost})`)
  return id
}
async function mkOrder(
  db: any,
  o: { user: string; key: string | null; pkg?: string | null; network?: string; price: number; status?: string; phone?: string; at?: string; ref?: string },
): Promise<void> {
  await db.exec(
    `INSERT INTO api_orders(user_id, api_key_id, api_v2_key_id, package_id, network, volume_gb, price, recipient_phone, api_reference, status, created_at)
     VALUES ('${o.user}', ${o.key ? "NULL" : "gen_random_uuid()"}, ${o.key ? `'${o.key}'` : "NULL"}, ${o.pkg ? `'${o.pkg}'` : "NULL"}, '${o.network ?? "MTN"}', 1, ${o.price},
             '${o.phone ?? "0241234567"}', '${o.ref ?? "ref-" + Math.random().toString(36).slice(2)}', '${o.status ?? "completed"}', ${o.at ?? "now()"})`,
  )
}
async function call(db: any, fn: string, ...args: (string | number | boolean | null)[]): Promise<any> {
  const a = args.map((x) => (x === null ? "NULL" : typeof x === "string" ? `'${x.replace(/'/g, "''")}'` : String(x))).join(", ")
  return (await one(db, `SELECT public.${fn}(${a}) AS r`)).r
}
async function auditCount(db: any, action?: string): Promise<number> {
  const w = action ? `WHERE action = '${action}'` : ""
  return (await one(db, `SELECT count(*)::int AS n FROM admin_audit_log ${w}`)).n
}
async function fails(db: any, sql: string, msg?: RegExp): Promise<any> {
  let err: any = null
  try {
    await db.exec(sql)
  } catch (e) {
    err = e
  }
  expect(err, `expected failure: ${sql}`).not.toBeNull()
  if (msg) expect(String(err.message)).toMatch(msg)
  return err
}
const SINCE = "now() - interval '30 days'"

describe.skipIf(!PGliteCtor)("0196 in PGlite", () => {
  it("tables: RLS on, zero policies, anon/authenticated have no privilege, service_role does", async () => {
    const db = await fresh96()
    for (const t of TABLES) {
      expect((await one(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.${t}'::regclass`)).r).toBe(true)
      expect((await one(db, `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='${t}'`)).n).toBe(0)
      for (const who of ["anon", "authenticated"]) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          expect((await one(db, `SELECT has_table_privilege('${who}', 'public.${t}', '${p}') AS h`)).h, `${who} ${p} ${t}`).toBe(false)
        }
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await one(db, `SELECT has_table_privilege('service_role', 'public.${t}', '${p}') AS h`)).h, `service_role ${p} ${t}`).toBe(true)
      }
    }
  }, 60_000)

  it("service_controls: seeded with 7 rows, all paused=false; an 8th service name refused; message of 201 characters refused", async () => {
    const db = await fresh96()
    const r = await rows(db, "SELECT service, paused, message FROM api_v2_service_controls ORDER BY service")
    expect(r.map((x) => x.service).sort()).toEqual([...SERVICES].sort())
    expect(r.every((x) => x.paused === false && x.message === null)).toBe(true)
    await fails(db, "INSERT INTO api_v2_service_controls(service) VALUES ('payments')", /check|violates/i)
    await fails(db, `UPDATE api_v2_service_controls SET message = '${"x".repeat(201)}' WHERE service = 'sms'`, /check|violates/i)
    await db.exec(`UPDATE api_v2_service_controls SET message = '${"x".repeat(200)}' WHERE service = 'sms'`)
    // applying twice re-seeds nothing and does not touch an existing row
    await db.exec("UPDATE api_v2_service_controls SET paused = true WHERE service = 'data'")
    await db.exec(migration())
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_service_controls")).n).toBe(7)
    expect((await one(db, "SELECT paused FROM api_v2_service_controls WHERE service = 'data'")).paused).toBe(true)
  }, 60_000)

  it("developer_pause: pause then re-pause -> changed:false, one audit row total; unpause removes the row, audit row api_developer_unpause", async () => {
    const db = await fresh96()
    const u = await mkUser(db)
    const a = await call(db, "api_v2_set_developer_pause", u, true, "  abuse of the order endpoint  ", ACTOR)
    expect(a).toMatchObject({ ok: true, changed: true })
    const row = await one(db, `SELECT * FROM api_v2_developer_pauses WHERE user_id = '${u}'`)
    expect(row.reason).toBe("abuse of the order endpoint")
    expect(row.paused_by).toBe(ACTOR)
    const b = await call(db, "api_v2_set_developer_pause", u, true, "second attempt", ACTOR)
    expect(b).toMatchObject({ ok: true, changed: false })
    expect((await one(db, `SELECT reason FROM api_v2_developer_pauses WHERE user_id = '${u}'`)).reason).toBe("abuse of the order endpoint")
    expect(await auditCount(db)).toBe(1)
    const audit = await one(db, "SELECT * FROM admin_audit_log")
    expect(audit).toMatchObject({ action: "api_developer_pause", target_user_id: u, admin_id: ACTOR })
    const c = await call(db, "api_v2_set_developer_pause", u, false, null, ACTOR)
    expect(c).toMatchObject({ ok: true, changed: true })
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_developer_pauses")).n).toBe(0)
    expect(await auditCount(db, "api_developer_unpause")).toBe(1)
    const d = await call(db, "api_v2_set_developer_pause", u, false, null, ACTOR)
    expect(d).toMatchObject({ ok: true, changed: false })
    expect(await auditCount(db)).toBe(2)
  }, 60_000)

  it("developer_pause: unknown user -> not_found; reason of 2 or 201 characters -> bad_reason; NULL actor raises 'actor is required'; failures write no audit row", async () => {
    const db = await fresh96()
    const u = await mkUser(db)
    const ghost = "11111111-1111-1111-1111-111111111111"
    expect(await call(db, "api_v2_set_developer_pause", ghost, true, "valid reason", ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_set_developer_pause", ghost, false, null, ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_set_developer_pause", null, true, "valid reason", ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_set_developer_pause", u, true, "ab", ACTOR)).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_set_developer_pause", u, true, "  a  ", ACTOR)).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_set_developer_pause", u, true, "x".repeat(201), ACTOR)).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_set_developer_pause", u, true, null, ACTOR)).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_set_developer_pause", u, true, "bad\nreason", ACTOR)).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_set_developer_pause", u, null, "valid reason", ACTOR)).toEqual({ ok: false, code: "bad_input" })
    await fails(db, `SELECT public.api_v2_set_developer_pause('${u}', true, 'valid reason', NULL)`, /actor is required/)
    expect(await auditCount(db)).toBe(0)
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_developer_pauses")).n).toBe(0)
    // exactly 3 and exactly 200 characters are accepted
    expect(await call(db, "api_v2_set_developer_pause", u, true, "abc", ACTOR)).toMatchObject({ ok: true, changed: true })
    await call(db, "api_v2_set_developer_pause", u, false, null, ACTOR)
    expect(await call(db, "api_v2_set_developer_pause", u, true, "y".repeat(200), ACTOR)).toMatchObject({ ok: true, changed: true })
  }, 60_000)

  it("developer_pause: pausing does not modify api_v2_keys (row versions xmin unchanged), grants or logs", async () => {
    const db = await fresh96()
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await mkLog(db, k, u, 200)
    await db.exec(`INSERT INTO api_v2_access_grants(user_id, granted_by) VALUES ('${u}', '${ACTOR}')`)
    const snap = async () => ({
      keys: await rows(db, "SELECT id, xmin::text AS x, status FROM api_v2_keys ORDER BY id"),
      grants: await rows(db, "SELECT user_id, xmin::text AS x FROM api_v2_access_grants ORDER BY user_id"),
      logs: await rows(db, "SELECT id, xmin::text AS x FROM api_v2_logs ORDER BY id"),
    })
    const before = await snap()
    expect(await call(db, "api_v2_set_developer_pause", u, true, "investigation", ACTOR)).toMatchObject({ changed: true })
    expect(await snap()).toEqual(before)
    await call(db, "api_v2_set_developer_pause", u, false, null, ACTOR)
    expect(await snap()).toEqual(before)
  }, 60_000)

  it("service_pause: pause with message -> row + audit with before/after; empty message -> NULL; control character -> bad_message; resume clears message", async () => {
    const db = await fresh96()
    const r = await call(db, "api_v2_set_service_pause", "airtime", true, "  Back at 14:00 UTC  ", ACTOR)
    expect(r).toMatchObject({ ok: true, changed: true })
    expect(await one(db, "SELECT paused, message, updated_by FROM api_v2_service_controls WHERE service = 'airtime'")).toEqual({ paused: true, message: "Back at 14:00 UTC", updated_by: ACTOR })
    const audit = await one(db, "SELECT * FROM admin_audit_log WHERE action = 'api_service_pause'")
    expect(audit.admin_id).toBe(ACTOR)
    expect(audit.target_user_id).toBeNull()
    expect(audit.old_value).toMatchObject({ service: "airtime", paused: false, message: null })
    expect(audit.new_value).toMatchObject({ service: "airtime", paused: true, message: "Back at 14:00 UTC" })
    // same state again: no change, no audit
    expect(await call(db, "api_v2_set_service_pause", "airtime", true, "Back at 14:00 UTC", ACTOR)).toMatchObject({ ok: true, changed: false })
    expect(await auditCount(db)).toBe(1)
    // empty message becomes NULL
    expect(await call(db, "api_v2_set_service_pause", "airtime", true, "   ", ACTOR)).toMatchObject({ changed: true })
    expect((await one(db, "SELECT message FROM api_v2_service_controls WHERE service = 'airtime'")).message).toBeNull()
    expect(await call(db, "api_v2_set_service_pause", "data", true, null, ACTOR)).toMatchObject({ changed: true })
    expect((await one(db, "SELECT message FROM api_v2_service_controls WHERE service = 'data'")).message).toBeNull()
    // refusals change and audit nothing
    const n = await auditCount(db)
    for (const bad of ["line\nbreak", "tab\there", "nul\u0001", "esc\u001b[31m", "bidi‮evil", "zero​width", "del\u007f", `${"x".repeat(201)}`]) {
      expect(await call(db, "api_v2_set_service_pause", "sms", true, bad, ACTOR), JSON.stringify(bad)).toEqual({ ok: false, code: "bad_message" })
    }
    expect(await call(db, "api_v2_set_service_pause", "sms", true, "x".repeat(200), ACTOR)).toMatchObject({ changed: true })
    await call(db, "api_v2_set_service_pause", "sms", false, null, ACTOR)
    expect(await auditCount(db)).toBe(n + 2)
    expect(await call(db, "api_v2_set_service_pause", "payments", true, null, ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_set_service_pause", null, true, null, ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_set_service_pause", "sms", null, null, ACTOR)).toEqual({ ok: false, code: "bad_input" })
    await fails(db, "SELECT public.api_v2_set_service_pause('sms', true, NULL, NULL)", /actor is required/)
    // resume clears the message, even when a message is passed
    expect(await call(db, "api_v2_set_service_pause", "airtime", true, "Maintenance", ACTOR)).toMatchObject({ changed: true })
    expect(await call(db, "api_v2_set_service_pause", "airtime", false, "ignored", ACTOR)).toMatchObject({ ok: true, changed: true })
    expect(await one(db, "SELECT paused, message FROM api_v2_service_controls WHERE service = 'airtime'")).toEqual({ paused: false, message: null })
    const resume = await one(db, "SELECT * FROM admin_audit_log WHERE action = 'api_service_resume' ORDER BY created_at DESC LIMIT 1")
    expect(resume.old_value).toMatchObject({ paused: true, message: "Maintenance" })
    expect(resume.new_value).toMatchObject({ paused: false, message: null })
    // resuming a running service is not a change
    const m = await auditCount(db)
    expect(await call(db, "api_v2_set_service_pause", "bills", false, null, ACTOR)).toMatchObject({ ok: true, changed: false })
    expect(await auditCount(db)).toBe(m)
  }, 60_000)

  it("announcement_save: create, update, ends<=starts -> bad_input, title 81 chars -> bad_input, severity 'boom' -> bad_input, 51st row -> too_many", async () => {
    const db = await fresh96()
    const S = "2030-01-01T00:00:00Z"
    const E = "2030-01-02T00:00:00Z"
    const c = await call(db, "api_v2_announcement_save", null, " Maintenance ", " Short outage tonight. ", "warning", S, E, ACTOR)
    expect(c).toMatchObject({ ok: true, changed: true })
    expect(typeof c.id).toBe("string")
    const stored = await one(db, `SELECT * FROM api_v2_announcements WHERE id = '${c.id}'`)
    expect(stored).toMatchObject({ title: "Maintenance", body: "Short outage tonight.", severity: "warning", created_by: ACTOR })
    expect(await auditCount(db, "api_announcement_save")).toBe(1)
    const a1 = await one(db, "SELECT * FROM admin_audit_log WHERE action = 'api_announcement_save'")
    expect(a1.new_value).toMatchObject({ id: c.id, title: "Maintenance", severity: "warning" })
    expect(JSON.stringify(a1)).not.toContain("Short outage")
    // update
    const u = await call(db, "api_v2_announcement_save", c.id, "Maintenance 2", "Short outage tonight.", "critical", S, E, ACTOR)
    expect(u).toMatchObject({ ok: true, changed: true, id: c.id })
    expect((await one(db, `SELECT title, severity, created_by FROM api_v2_announcements WHERE id = '${c.id}'`))).toEqual({ title: "Maintenance 2", severity: "critical", created_by: ACTOR })
    expect(await auditCount(db, "api_announcement_save")).toBe(2)
    // identical update changes and audits nothing
    expect(await call(db, "api_v2_announcement_save", c.id, "Maintenance 2", "Short outage tonight.", "critical", S, E, ACTOR)).toMatchObject({ ok: true, changed: false })
    expect(await auditCount(db, "api_announcement_save")).toBe(2)
    // unknown id on update
    expect(await call(db, "api_v2_announcement_save", "22222222-2222-2222-2222-222222222222", "t", "b", "info", S, E, ACTOR)).toEqual({ ok: false, code: "not_found" })
    // bad input
    const bad = async (title: string | null, body: string | null, sev: string | null, s: string | null, e: string | null) =>
      expect(await call(db, "api_v2_announcement_save", null, title, body, sev, s, e, ACTOR), JSON.stringify([title, body, sev, s, e])).toEqual({ ok: false, code: "bad_input" })
    await bad("t", "b", "info", S, S) // ends = starts
    await bad("t", "b", "info", E, S) // ends < starts
    await bad("x".repeat(81), "b", "info", S, E)
    await bad("", "b", "info", S, E)
    await bad("   ", "b", "info", S, E)
    await bad("t", "", "info", S, E)
    await bad("t", "x".repeat(1001), "info", S, E)
    await bad("t", "b", "boom", S, E)
    await bad("t", "b", null, S, E)
    await bad(null, "b", "info", S, E)
    await bad("t", null, "info", S, E)
    await bad("t", "b", "info", null, E)
    await bad("t", "b", "info", S, null)
    await bad("two\nlines", "b", "info", S, E)
    await bad("t", "bidi‮evil", "info", S, E)
    await bad("t", "nul\u0001", "info", S, E)
    expect(await call(db, "api_v2_announcement_save", null, "x".repeat(80), "b".repeat(1000), "info", S, E, ACTOR)).toMatchObject({ ok: true })
    // a body may hold line breaks
    expect(await call(db, "api_v2_announcement_save", null, "multi", "line one\nline two", "info", S, E, ACTOR)).toMatchObject({ ok: true })
    await fails(db, `SELECT public.api_v2_announcement_save(NULL, 't', 'b', 'info', '${S}', '${E}', NULL)`, /actor is required/)
    // the 51st row
    const have = (await one(db, "SELECT count(*)::int AS n FROM api_v2_announcements")).n
    for (let i = have; i < 50; i++) {
      expect(await call(db, "api_v2_announcement_save", null, `n${i}`, "b", "info", S, E, ACTOR)).toMatchObject({ ok: true })
    }
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_announcements")).n).toBe(50)
    const audits = await auditCount(db)
    expect(await call(db, "api_v2_announcement_save", null, "one too many", "b", "info", S, E, ACTOR)).toEqual({ ok: false, code: "too_many" })
    expect(await auditCount(db)).toBe(audits)
    // an update is still allowed at the cap
    expect(await call(db, "api_v2_announcement_save", c.id, "Maintenance 3", "Short outage tonight.", "critical", S, E, ACTOR)).toMatchObject({ ok: true, changed: true })
  }, 120_000)

  it("announcement_delete: removes + audits; unknown -> not_found", async () => {
    const db = await fresh96()
    const c = await call(db, "api_v2_announcement_save", null, "Gone soon", "body text", "info", "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", ACTOR)
    const d = await call(db, "api_v2_announcement_delete", c.id, ACTOR)
    expect(d).toMatchObject({ ok: true, changed: true, id: c.id })
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_announcements")).n).toBe(0)
    const a = await one(db, "SELECT * FROM admin_audit_log WHERE action = 'api_announcement_delete'")
    expect(a.admin_id).toBe(ACTOR)
    expect(a.old_value).toMatchObject({ id: c.id, title: "Gone soon", severity: "info" })
    expect(JSON.stringify(a)).not.toContain("body text")
    const n = await auditCount(db)
    expect(await call(db, "api_v2_announcement_delete", c.id, ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_announcement_delete", null, ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await auditCount(db)).toBe(n)
    await fails(db, `SELECT public.api_v2_announcement_delete('${c.id}', NULL)`, /actor is required/)
  }, 60_000)

  it("developers: lists a user with only a pause row; ilike metacharacters in p_search (%, _, \\) match literally; p_limit 1000 is clamped to 100", async () => {
    const db = await fresh96()
    const onlyPause = await mkUser(db, { first: "Pause", last: "Only", email: "pause.only@example.test" })
    const onlyGrant = await mkUser(db, { first: "Grant", last: "Only", email: "grant.only@example.test" })
    const withKey = await mkUser(db, { first: "Kofi", last: "Key", email: "kofi@example.test" })
    const nobody = await mkUser(db, { first: "No", last: "Body", email: "nobody@example.test" })
    await call(db, "api_v2_set_developer_pause", onlyPause, true, "investigation", ACTOR)
    await db.exec(`INSERT INTO api_v2_access_grants(user_id, granted_by) VALUES ('${onlyGrant}', '${ACTOR}')`)
    await mkKey(db, withKey)
    const all = await call(db, "api_v2_developers", null, null, null, null)
    expect(all.total).toBe(3)
    const ids = all.items.map((i: any) => i.user_id)
    expect(ids).toContain(onlyPause)
    expect(ids).toContain(onlyGrant)
    expect(ids).toContain(withKey)
    expect(ids).not.toContain(nobody)
    const p = all.items.find((i: any) => i.user_id === onlyPause)
    expect(p).toMatchObject({ paused: true, granted: false, keys_active: 0, requests: 0, email: "pause.only@example.test", first_name: "Pause" })
    expect(all.items.find((i: any) => i.user_id === onlyGrant)).toMatchObject({ granted: true, paused: false })
    // search, case-insensitive, by name or email
    expect((await call(db, "api_v2_developers", null, "KOFI", 25, 0)).items.map((i: any) => i.user_id)).toEqual([withKey])
    expect((await call(db, "api_v2_developers", null, "grant.only@", 25, 0)).total).toBe(1)
    // metacharacters are literal: a developer whose name contains them is found, others are not matched by the wildcard
    const weird = await mkUser(db, { first: "100%_real", last: "back\\slash", email: "w@example.test" })
    await mkKey(db, weird)
    const lit = async (q: string) => (await call(db, "api_v2_developers", null, q, 25, 0)).items.map((i: any) => i.user_id)
    expect(await lit("%")).toEqual([weird])
    expect(await lit("_")).toEqual([weird])
    expect(await lit("100%_")).toEqual([weird])
    expect(await lit("\\")).toEqual([weird])
    expect(await lit("k_fi")).toEqual([]) // '_' must not match 'o'
    expect(await lit("ko%i")).toEqual([]) // '%' must not match 'f'
    expect(await lit("%%")).toEqual([])
    // search longer than 60 characters is cut to 60 (no error)
    expect((await call(db, "api_v2_developers", null, "k".repeat(200), 25, 0)).total).toBe(0)
    // limit clamp and offset clamp, with a tiny page to prove ordering is stable and paged
    const page1 = await call(db, "api_v2_developers", null, null, 1, 0)
    const page2 = await call(db, "api_v2_developers", null, null, 1, 1)
    expect(page1.items).toHaveLength(1)
    expect(page2.items).toHaveLength(1)
    expect(page1.items[0].user_id).not.toBe(page2.items[0].user_id)
    expect(page1.total).toBe(4)
    for (let i = 0; i < 110; i++) {
      const u = await mkUser(db, { first: "Bulk", last: `N${i}`, email: `bulk${i}@example.test` })
      await mkKey(db, u)
    }
    const big = await call(db, "api_v2_developers", null, null, 1000, 0)
    expect(big.items).toHaveLength(100)
    expect(big.total).toBe(114)
    expect((await call(db, "api_v2_developers", null, null, 0, 0)).items).toHaveLength(1)
    expect((await call(db, "api_v2_developers", null, null, -5, -9)).items).toHaveLength(1)
    expect((await call(db, "api_v2_developers", null, null, 100, 110)).items).toHaveLength(4)
  }, 120_000)

  it("developer_profile: totals equal api_v2_key_activity summed over the user's keys; at most 20 orders, newest first; failed/refunded orders excluded from spend", async () => {
    const db = await fresh96()
    const u = await mkUser(db, { first: "Esi", last: "Owusu", email: "esi@example.test" })
    const other = await mkUser(db)
    const k1 = await mkKey(db, u, { type: "standard" })
    const k2 = await mkKey(db, u, { type: "commission" })
    const ko = await mkKey(db, other)
    for (const s of [200, 201, 404, 500, 429]) await mkLog(db, k1, u, s)
    for (const s of [200, 403]) await mkLog(db, k2, u, s)
    await mkLog(db, ko, other, 200)
    await mkLog(db, k1, u, 200, { at: "now() - interval '60 days'" }) // outside the window
    await mkOrder(db, { user: u, key: k1, price: 10.5, status: "completed" })
    await mkOrder(db, { user: u, key: k1, price: 4, status: "pending" })
    await mkOrder(db, { user: u, key: k2, price: 99, status: "failed" })
    await mkOrder(db, { user: u, key: k2, price: 77, status: "refunded" })
    await mkOrder(db, { user: other, key: ko, price: 1000, status: "completed" })
    await mkOrder(db, { user: u, key: null, price: 555, status: "completed" }) // a v1 order: never attributed
    const p = await call(db, "api_v2_developer_profile", u, null)
    expect(p.user).toMatchObject({ id: u, first_name: "Esi", last_name: "Owusu", email: "esi@example.test", role: "dealer", is_suspended: false })
    expect(p.grant).toBeNull()
    expect(p.pause).toBeNull()
    // totals vs api_v2_key_activity
    const act = async (k: string) => (await one(db, `SELECT public.api_v2_key_activity('${k}', ${SINCE}) AS r`)).r
    const x1 = await act(k1)
    const x2 = await act(k2)
    expect(p.totals.requests).toBe(x1.requests + x2.requests)
    expect(p.totals.ok).toBe(x1.ok + x2.ok)
    expect(p.totals.failed).toBe(x1.failed + x2.failed)
    expect(Number(p.totals.spent)).toBeCloseTo(x1.spent + x2.spent, 2)
    expect(p.totals.orders).toBe(x1.orders + x2.orders)
    expect(p.totals.pending).toBe(x1.pending + x2.pending)
    expect(p.totals.requests).toBe(7)
    expect(Number(p.totals.spent)).toBeCloseTo(14.5, 2)
    expect(p.totals.orders).toBe(2)
    // keys with per-key activity (reuses api_v2_key_activity), and never a hash
    expect(p.keys).toHaveLength(2)
    const pk1 = p.keys.find((k: any) => k.id === k1)
    expect(pk1.activity.requests).toBe(x1.requests)
    expect(JSON.stringify(p)).not.toMatch(/key_hash|h-[0-9a-f]{8}-/)
    // orders: all statuses are listed, masked phone, no raw phone anywhere
    expect(p.orders).toHaveLength(4)
    expect(p.orders.every((o: any) => o.recipient_phone === "******4567")).toBe(true)
    expect(JSON.stringify(p)).not.toContain("0241234567")
    expect(p.orders.map((o: any) => Number(o.price)).sort((x: number, y: number) => x - y)).toEqual([4, 10.5, 77, 99])
    // daily buckets sum to the totals
    expect(p.daily.reduce((n: number, d: any) => n + d.requests, 0)).toBe(7)
    expect(p.daily.reduce((n: number, d: any) => n + Number(d.revenue), 0)).toBeCloseTo(14.5, 2)
    // newest first and capped at 20
    for (let i = 0; i < 25; i++) {
      await mkOrder(db, { user: u, key: k1, price: 1, status: "completed", at: `now() - interval '${i + 1} minutes'`, ref: `bulk-${i}` })
    }
    const p2 = await call(db, "api_v2_developer_profile", u, null)
    expect(p2.orders).toHaveLength(20)
    const times = p2.orders.map((o: any) => new Date(o.created_at).getTime())
    expect([...times].sort((x: number, y: number) => y - x)).toEqual(times)
    // grant, pause and the audit tail
    await db.exec(`INSERT INTO api_v2_access_grants(user_id, granted_by) VALUES ('${u}', '${ACTOR}')`)
    await call(db, "api_v2_set_developer_pause", u, true, "chargeback investigation", ACTOR)
    const p3 = await call(db, "api_v2_developer_profile", u, null)
    expect(p3.grant).toMatchObject({ granted_by: ACTOR })
    expect(p3.pause).toMatchObject({ paused_by: ACTOR, reason: "chargeback investigation" })
    expect(p3.audit).toHaveLength(1)
    expect(p3.audit[0]).toMatchObject({ action: "api_developer_pause", admin_id: ACTOR, reason: "chargeback investigation" })
    // unknown user or NULL -> SQL NULL
    expect(await call(db, "api_v2_developer_profile", "33333333-3333-3333-3333-333333333333", null)).toBeNull()
    expect(await call(db, "api_v2_developer_profile", null, null)).toBeNull()
  }, 120_000)

  it("overview_trend: per-day buckets, revenue excludes failed/refunded, empty days present or absent as documented", async () => {
    const db = await fresh96()
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    const d = (n: number) => `date_trunc('day', now()) - interval '${n} days' + interval '12 hours'`
    await mkLog(db, k, u, 200, { at: d(2) })
    await mkLog(db, k, u, 200, { at: d(2) })
    await mkLog(db, k, u, 500, { at: d(2) })
    await mkLog(db, k, u, 404, { at: d(5) })
    await mkLog(db, k, u, 200, { at: "now() - interval '90 days'" }) // outside the window
    await mkOrder(db, { user: u, key: k, price: 10, status: "completed", at: d(2) })
    await mkOrder(db, { user: u, key: k, price: 5, status: "pending", at: d(2) })
    await mkOrder(db, { user: u, key: k, price: 50, status: "failed", at: d(2) })
    await mkOrder(db, { user: u, key: k, price: 60, status: "refunded", at: d(2) })
    await mkOrder(db, { user: u, key: null, price: 70, status: "completed", at: d(2) }) // v1
    await mkOrder(db, { user: u, key: k, price: 3, status: "completed", at: d(8) }) // orders without requests that day
    const day = async (n: number) => (await one(db, `SELECT to_char(${d(n)}, 'YYYY-MM-DD') AS s`)).s
    const t = await call(db, "api_v2_overview_trend", null)
    expect(Array.isArray(t)).toBe(true)
    const by = Object.fromEntries(t.map((r: any) => [r.day, r]))
    expect(by[await day(2)]).toMatchObject({ requests: 3, ok: 2, failed: 1 })
    expect(Number(by[await day(2)].revenue)).toBeCloseTo(15, 2)
    expect(by[await day(5)]).toMatchObject({ requests: 1, ok: 0, failed: 1 })
    expect(Number(by[await day(5)].revenue)).toBe(0)
    expect(by[await day(8)]).toMatchObject({ requests: 0, ok: 0, failed: 0 })
    expect(Number(by[await day(8)].revenue)).toBeCloseTo(3, 2)
    // documented: a day with neither requests nor orders is absent, days are ascending text 'YYYY-MM-DD', the 90-day-old row is outside the 30-day default
    expect(t).toHaveLength(3)
    expect(by[await day(3)]).toBeUndefined()
    expect(t.map((r: any) => r.day)).toEqual([...t.map((r: any) => r.day)].sort())
    expect(t.every((r: any) => /^\d{4}-\d{2}-\d{2}$/.test(r.day))).toBe(true)
    // an explicit wider window includes the old row
    expect((await call(db, "api_v2_overview_trend", new Date(Date.now() - 100 * 86400_000).toISOString())).length).toBe(4)
    // the trend revenue over the window equals the existing stats revenue
    const stats = await one(db, `SELECT public.api_v2_admin_stats(${SINCE}) AS r`)
    expect(t.reduce((n: number, r: any) => n + Number(r.revenue), 0)).toBeCloseTo(stats.r.revenue, 2)
  }, 60_000)

  it("business_report: costed order -> costed_orders=1, cost_total set; uncosted order -> costed_orders=0; NULL package_id -> uncosted; revenue total equals api_v2_admin_stats.revenue for the window", async () => {
    const db = await fresh96()
    const u = await mkUser(db, { first: "Yaw", last: "Boateng", email: "yaw@example.test" })
    const u2 = await mkUser(db, { first: "Adwoa", last: "Darko", email: "adwoa@example.test" })
    const k = await mkKey(db, u)
    const k2 = await mkKey(db, u2)
    const costed = await mkPkg(db, 4.25)
    const uncosted = await mkPkg(db)
    await mkOrder(db, { user: u, key: k, pkg: costed, network: "MTN", price: 6, status: "completed" })
    await mkOrder(db, { user: u, key: k, pkg: costed, network: "MTN", price: 6, status: "pending" })
    await mkOrder(db, { user: u, key: k, pkg: uncosted, network: "AT", price: 3.5, status: "completed" })
    await mkOrder(db, { user: u, key: k, pkg: null, network: "AT", price: 2, status: "completed" }) // package deleted
    await mkOrder(db, { user: u, key: k, pkg: costed, network: "MTN", price: 9, status: "failed" })
    await mkOrder(db, { user: u, key: k, pkg: costed, network: "MTN", price: 9, status: "refunded" })
    await mkOrder(db, { user: u, key: null, pkg: costed, network: "MTN", price: 100, status: "completed" }) // v1
    await mkOrder(db, { user: u2, key: k2, pkg: uncosted, network: "Telecel", price: 8, status: "completed" })
    await mkOrder(db, { user: u, key: k, pkg: costed, network: "MTN", price: 11, status: "completed", at: "now() - interval '45 days'" })
    const from = "now() - interval '90 days'"
    const rep = (await one(db, `SELECT public.api_v2_business_report(${from}, now() + interval '1 day') AS r`)).r
    expect(Array.isArray(rep)).toBe(true)
    const find = (user: string, product: string, month?: string) => rep.filter((r: any) => r.user_id === user && r.product === product && (!month || r.month === month))
    const thisMonth = (await one(db, "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS m")).m
    const mtnNow = find(u, "MTN", thisMonth)
    expect(mtnNow).toHaveLength(1)
    expect(mtnNow[0]).toMatchObject({ developer: "Yaw Boateng", email: "yaw@example.test", orders: 2, costed_orders: 2 })
    expect(Number(mtnNow[0].revenue)).toBeCloseTo(12, 2)
    expect(Number(mtnNow[0].costed_revenue)).toBeCloseTo(12, 2)
    expect(Number(mtnNow[0].cost_total)).toBeCloseTo(8.5, 2)
    const at = find(u, "AT")
    expect(at).toHaveLength(1)
    expect(at[0]).toMatchObject({ orders: 2, costed_orders: 0 })
    expect(Number(at[0].revenue)).toBeCloseTo(5.5, 2)
    expect(Number(at[0].costed_revenue)).toBe(0)
    expect(Number(at[0].cost_total)).toBe(0)
    const tele = find(u2, "Telecel")
    expect(tele[0]).toMatchObject({ orders: 1, costed_orders: 0 })
    // rows are keyed by month, user and product; an older month is its own row
    expect(find(u, "MTN")).toHaveLength(2)
    expect(new Set(rep.map((r: any) => r.month)).size).toBe(2)
    expect(rep.reduce((n: number, r: any) => n + r.orders, 0)).toBe(6)
    // the money rule is the one of api_v2_admin_stats
    const stats = (await one(db, `SELECT public.api_v2_admin_stats(${from}) AS r`)).r
    expect(rep.reduce((n: number, r: any) => n + Number(r.revenue), 0)).toBeCloseTo(stats.revenue, 2)
    expect(rep.reduce((n: number, r: any) => n + r.orders, 0)).toBe(stats.orders)
    // the window is [from, to): a narrow window drops the 45-day-old order
    const narrow = (await one(db, "SELECT public.api_v2_business_report(now() - interval '30 days', now() + interval '1 day') AS r")).r
    expect(narrow.reduce((n: number, r: any) => n + r.orders, 0)).toBe(5)
    // guards: missing bounds, inverted range and an oversized range are refused
    await fails(db, "SELECT public.api_v2_business_report(NULL, now())", /from and to are required/)
    await fails(db, "SELECT public.api_v2_business_report(now() - interval '1000 days', now())", /range too large/)
    expect((await one(db, "SELECT public.api_v2_business_report(now(), now() - interval '1 day') AS r")).r).toEqual([])
  }, 60_000)

  it("public_health: only environment='live' rows; contains no user_id/key_id/ip fields", async () => {
    const db = await fresh96()
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await mkLog(db, k, u, 200, { endpoint: "/api/v2/data/orders" })
    await mkLog(db, k, u, 500, { endpoint: "/api/v2/data/orders" })
    await mkLog(db, k, u, 503, { endpoint: "/api/v2/data/orders" })
    await mkLog(db, k, u, 404, { endpoint: "/api/v2/data/orders" })
    await mkLog(db, k, u, 500, { endpoint: "/api/v2/data/orders", env: "test" })
    await mkLog(db, k, u, 500, { endpoint: "/api/v2/airtime/orders", env: "test" })
    await mkLog(db, k, u, 200, { endpoint: "/api/v2/sms/send" })
    await mkLog(db, k, u, 200, { endpoint: "/api/v2/old", at: "now() - interval '3 days'" })
    await db.exec(`INSERT INTO api_v2_logs(key_id, user_id, method, endpoint, status_code, environment, ip_address) VALUES (NULL, NULL, 'GET', '/api/v2/anon', 401, NULL, '203.0.113.9')`)
    const h = await call(db, "api_v2_public_health", null)
    expect(h).toEqual([
      { endpoint: "/api/v2/data/orders", total: 4, failed: 2 },
      { endpoint: "/api/v2/sms/send", total: 1, failed: 0 },
    ])
    const text = JSON.stringify(h)
    expect(text).not.toMatch(/user_id|key_id|ip_address|203\.0\.113|environment/)
    expect(Object.keys(h[0]).sort()).toEqual(["endpoint", "failed", "total"])
    // an explicit window reaches further back
    const wide = await call(db, "api_v2_public_health", new Date(Date.now() - 10 * 86400_000).toISOString())
    expect(wide.map((r: any) => r.endpoint)).toContain("/api/v2/old")
  }, 60_000)

  it("privileges: has_function_privilege false for anon/authenticated and true for service_role on all 9 functions", async () => {
    const db = await fresh96()
    expect(FUNCTIONS).toHaveLength(9)
    for (const f of FUNCTIONS) {
      expect((await one(db, `SELECT to_regprocedure('public.${f}') IS NOT NULL AS ok`)).ok, f).toBe(true)
      for (const who of ["anon", "authenticated", "public"]) {
        expect((await one(db, `SELECT has_function_privilege('${who}', 'public.${f}', 'EXECUTE') AS h`)).h, `${who} ${f}`).toBe(false)
      }
      expect((await one(db, `SELECT has_function_privilege('service_role', 'public.${f}', 'EXECUTE') AS h`)).h, `service_role ${f}`).toBe(true)
    }
    // every function is SECURITY DEFINER with a pinned search_path
    const defs = await rows(db, `SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (${FUNCTIONS.map((f) => `'${f.split("(")[0]}'`).join(",")})`)
    expect(defs).toHaveLength(9)
    for (const d of defs) {
      expect(d.prosecdef, d.proname).toBe(true)
      expect((d.proconfig ?? []).join(" "), d.proname).toMatch(/search_path=public, pg_temp/)
    }
  }, 60_000)

  it("a pause row dies with its auth user (cascade) and a pause for an unknown auth user is refused by the key", async () => {
    const db = await fresh96()
    const u = await mkUser(db)
    await call(db, "api_v2_set_developer_pause", u, true, "temporary", ACTOR)
    await db.exec(`DELETE FROM public.users WHERE id = '${u}'`)
    await db.exec(`DELETE FROM auth.users WHERE id = '${u}'`)
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_developer_pauses")).n).toBe(0)
    await fails(db, `INSERT INTO api_v2_developer_pauses(user_id, paused_by, reason) VALUES (gen_random_uuid(), '${ACTOR}', 'abc')`, /foreign key|violates/i)
    const v = await mkUser(db)
    await fails(db, `INSERT INTO api_v2_developer_pauses(user_id, paused_by, reason) VALUES ('${v}', '${ACTOR}', 'ab')`, /check|violates/i)
    await fails(db, `INSERT INTO api_v2_announcements(title, body, severity, starts_at, ends_at, created_by) VALUES ('t','b','info', now(), now(), '${ACTOR}')`, /check|violates/i)
  }, 60_000)

  it("selftest: raises SELFTEST_OK 0196 inside a transaction that leaves nothing behind (count rows before/after in the test)", async () => {
    const db = await fresh()
    const u = await mkUser(db, { email: "probe@example.test" })
    const k = await mkKey(db, u)
    await mkLog(db, k, u, 200)
    const pkg = await mkPkg(db, 2)
    await mkOrder(db, { user: u, key: k, pkg, price: 5 })
    await db.exec(`INSERT INTO public.admin_audit_log(admin_id, action) VALUES ('${ACTOR}', 'seed')`)
    const counts = async () =>
      JSON.stringify([
        await one(db, "SELECT count(*)::int AS n FROM auth.users"),
        await one(db, "SELECT count(*)::int AS n FROM public.users"),
        await one(db, "SELECT count(*)::int AS n FROM api_v2_keys"),
        await one(db, "SELECT count(*)::int AS n FROM api_v2_logs"),
        await one(db, "SELECT count(*)::int AS n FROM api_orders"),
        await one(db, "SELECT count(*)::int AS n FROM admin_audit_log"),
        await one(db, "SELECT count(*)::int AS n FROM api_v2_access_grants"),
        await rows(db, "SELECT id, xmin::text AS x FROM api_v2_keys ORDER BY id"),
        await rows(db, "SELECT id, xmin::text AS x FROM public.users ORDER BY id"),
      ])
    const before = await counts()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0196/)
    await db.exec("ROLLBACK")
    expect(await counts()).toBe(before)
    for (const t of TABLES) expect((await one(db, `SELECT to_regclass('public.${t}') AS t`)).t).toBeNull()
    for (const f of FUNCTIONS) expect((await one(db, `SELECT to_regprocedure('public.${f}') AS t`)).t).toBeNull()
  }, 120_000)

  it("selftest: also passes on an empty database (no users at all) and against the already-applied schema (run alone after the real apply)", async () => {
    const empty = await fresh()
    await expect(empty.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0196/)
    await empty.exec("ROLLBACK")

    const db = await fresh96()
    const u = await mkUser(db, { email: "probe2@example.test" })
    const k = await mkKey(db, u)
    await mkLog(db, k, u, 200)
    await mkOrder(db, { user: u, key: k, price: 5 })
    await call(db, "api_v2_set_service_pause", "bills", true, "real pause", ACTOR)
    const st = read(SELFTEST_FILE)
    const doBlock = st.split("\n").slice(st.split("\n").findIndex((l) => /^DO\b/.test(l))).join("\n")
    await db.exec("BEGIN")
    await expect(db.exec(doBlock)).rejects.toThrow(/^SELFTEST_OK 0196/)
    await db.exec("ROLLBACK")
    // the real pause survived the self-test
    expect(await one(db, "SELECT paused, message FROM api_v2_service_controls WHERE service = 'bills'")).toEqual({ paused: true, message: "real pause" })
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_developer_pauses")).n).toBe(0)
  }, 120_000)

  it("applies twice without error and keeps data written between the two applies", async () => {
    const db = await fresh96()
    const u = await mkUser(db)
    await call(db, "api_v2_set_developer_pause", u, true, "kept across re-apply", ACTOR)
    await call(db, "api_v2_announcement_save", null, "kept", "body", "info", "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", ACTOR)
    await db.exec(migration())
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_developer_pauses")).n).toBe(1)
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_announcements")).n).toBe(1)
    for (const t of TABLES) {
      expect((await one(db, `SELECT has_table_privilege('authenticated', 'public.${t}', 'SELECT') AS h`)).h).toBe(false)
    }
  }, 60_000)
})
