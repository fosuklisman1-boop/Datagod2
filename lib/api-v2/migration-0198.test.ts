// lib/api-v2/migration-0198.test.ts
// migrations/0198_api_money_protection.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0198 builds on 0128 (api_v2_keys, api_v2_logs, loaded for real), the 0195 error_reason column (added here as production has it),
// admin_audit_log (stubbed as 0069 + 0176 leave it) and the order table as far as the risk scan reads it.
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0198-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0198_api_money_protection.sql"
const SELFTEST_FILE = "0198_api_money_protection.selftest.sql"
const migration = () => read(FILE)

const FUNCTIONS = [
  "api_v2_spend_reserve(uuid,uuid,text,text,numeric)",
  "api_v2_spend_settle(uuid,text,text,text,numeric)",
  "api_v2_set_spend_cap(text,uuid,numeric,uuid)",
  "api_v2_set_money_settings(boolean,boolean,jsonb,uuid)",
  "api_v2_spend_today(uuid)",
  "api_v2_risk_scan(timestamptz)",
]
const TABLES = ["api_v2_money_settings", "api_v2_spend_caps", "api_v2_spend_ledger", "api_v2_risk_alerts"]
const DEFAULT_THRESHOLDS = {
  spike_multiplier: 3,
  spike_min_ghs: 200,
  new_key_hours: 24,
  new_key_min_ghs: 100,
  fanout_recipients: 30,
  fanout_minutes: 10,
  cap_hits: 3,
  cap_hits_minutes: 60,
  failure_min_orders: 20,
  failure_ratio: 0.5,
  failure_minutes: 15,
}

describe("0198 migration text", () => {
  it("one BEGIN, both SET LOCALs, one COMMIT; run string ends RAISE 'SELFTEST_OK 0198' and has no COMMIT", () => {
    const c = code(migration())
    expect(c.match(/^BEGIN;\s*$/gm)).toHaveLength(1)
    expect(c).toMatch(/SET LOCAL lock_timeout = '2s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '15s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0198';\s*END\s*\$selftest\$;$/)
    expect(() => buildRunString(migration().replace(/^COMMIT;$/m, ""), read(SELFTEST_FILE))).toThrow(/0198:no COMMIT/)
  })

  it("header has PRE-CHECKS and VERIFY; no ALTER of an existing table; no FK to auth.*", () => {
    const m = migration()
    const header = m.slice(0, m.indexOf("\nBEGIN;"))
    expect(header).toContain("PRE-CHECKS")
    expect(header).toContain("VERIFY")
    expect(header).toMatch(/error_reason/)
    const c = code(m)
    expect(c).not.toMatch(/ALTER TABLE\s+(IF EXISTS\s+)?(ONLY\s+)?(public\.)?(api_v2_keys|api_v2_logs|api_v2_config|api_orders|users|admin_audit_log)\b/i)
    expect(c).not.toMatch(/REFERENCES\s+auth\./i)
  })

  it("every function is SECURITY DEFINER, pinned search_path, revoked from PUBLIC/anon/authenticated", () => {
    const c = code(migration())
    expect((c.match(/SECURITY DEFINER/g) ?? []).length).toBe(FUNCTIONS.length)
    expect((c.match(/SET search_path = public, pg_temp/g) ?? []).length).toBe(FUNCTIONS.length)
    expect((c.match(/FROM PUBLIC, anon, authenticated/g) ?? []).length).toBeGreaterThanOrEqual(FUNCTIONS.length + TABLES.length)
  })

  it("reserve takes the per-user advisory lock before it sums (parallel reserves of one person are serialised)", () => {
    const c = code(migration())
    const body = c.slice(c.indexOf("FUNCTION public.api_v2_spend_reserve"), c.indexOf("FUNCTION public.api_v2_spend_settle"))
    const lock = body.indexOf("pg_advisory_xact_lock")
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(body.indexOf("sum("))
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
  CREATE TABLE public.users(id uuid PRIMARY KEY REFERENCES auth.users(id), first_name text, last_name text, email text, role text,
    is_suspended boolean NOT NULL DEFAULT false);
  CREATE TABLE public.admin_audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid, action text NOT NULL,
    target_user_id uuid, old_value jsonb, new_value jsonb, created_at timestamptz NOT NULL DEFAULT now());
`
const STUBS_ORDERS = `
  CREATE TABLE public.api_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, api_key_id uuid, api_v2_key_id uuid REFERENCES public.api_v2_keys(id),
    package_id uuid, network text, volume_gb numeric, price numeric, recipient_phone text, api_reference text, status text,
    created_at timestamptz NOT NULL DEFAULT now());
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
  await db.exec(STUBS_ORDERS)
  await db.exec("ALTER TABLE public.api_v2_logs ADD COLUMN IF NOT EXISTS error_reason text")
  return db
}
async function fresh98(o: { caps?: boolean; alerts?: boolean } = {}): Promise<any> {
  const db = await fresh()
  await db.exec(migration())
  if (o.caps || o.alerts) {
    await db.exec(`UPDATE api_v2_money_settings SET caps_enabled = ${!!o.caps}, alerts_enabled = ${!!o.alerts} WHERE id = 1`)
  }
  return db
}

const ACTOR = "00000000-0000-0000-0000-0000000000a1"
async function rows(db: any, sql: string): Promise<any[]> {
  return (await db.query(sql)).rows
}
async function one(db: any, sql: string): Promise<any> {
  return (await rows(db, sql))[0]
}
async function mkUser(db: any, first = "Ama"): Promise<string> {
  const id = (await one(db, "SELECT gen_random_uuid() AS id")).id
  await db.exec(`INSERT INTO auth.users(id) VALUES ('${id}')`)
  await db.exec(`INSERT INTO public.users(id, first_name, last_name, email, role) VALUES ('${id}', '${first}', 'Mensah', 'u-${id}@example.test', 'dealer')`)
  return id
}
// One live key per (user, key_type) is a 0128 rule: a second live key of one person needs another type.
async function mkKey(db: any, user: string, o: { env?: string; at?: string; type?: string } = {}): Promise<string> {
  return (
    await one(
      db,
      `INSERT INTO api_v2_keys(user_id, key_type, environment, status, name, key_hash, key_prefix, created_at)
       VALUES ('${user}', '${o.type ?? "standard"}', '${o.env ?? "live"}', 'active', 'k', 'h-' || gen_random_uuid()::text, 'pfx', ${o.at ?? "now()"}) RETURNING id`,
    )
  ).id
}
async function call(db: any, fn: string, ...args: (string | number | boolean | null)[]): Promise<any> {
  const a = args.map((x) => (x === null ? "NULL" : typeof x === "string" ? `'${x.replace(/'/g, "''")}'` : String(x))).join(", ")
  return (await one(db, `SELECT public.${fn}(${a}) AS r`)).r
}
const reserve = (db: any, u: string, k: string, ref: string, amount: number, kind = "airtime") =>
  call(db, "api_v2_spend_reserve", u, k, kind, ref, amount)
async function capKey(db: any, k: string, cap: number): Promise<void> {
  await db.exec(`INSERT INTO api_v2_spend_caps(scope, scope_id, daily_cap, set_by) VALUES ('key', '${k}', ${cap}, '${ACTOR}')`)
}
async function capUser(db: any, u: string, cap: number): Promise<void> {
  await db.exec(`INSERT INTO api_v2_spend_caps(scope, scope_id, daily_cap, set_by) VALUES ('user', '${u}', ${cap}, '${ACTOR}')`)
}
const ledgerCount = async (db: any, where = "true") => (await one(db, `SELECT count(*)::int AS n FROM api_v2_spend_ledger WHERE ${where}`)).n
const auditCount = async (db: any, action: string) => (await one(db, `SELECT count(*)::int AS n FROM admin_audit_log WHERE action = '${action}'`)).n
async function mkOrder(db: any, o: { user: string; key: string; price: number; status?: string; phone?: string; at?: string }): Promise<void> {
  await db.exec(
    `INSERT INTO api_orders(user_id, api_v2_key_id, network, volume_gb, price, recipient_phone, api_reference, status, created_at)
     VALUES ('${o.user}', '${o.key}', 'MTN', 1, ${o.price}, '${o.phone ?? "0241234567"}', 'r-' || gen_random_uuid()::text, '${o.status ?? "completed"}', ${o.at ?? "now()"})`,
  )
}

describe.skipIf(!PGliteCtor)("0198 in PGlite", () => {
  it("privileges: anon/authenticated have no table or function access; service_role can execute each function", async () => {
    const db = await fresh98()
    for (const t of TABLES) {
      expect((await one(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.${t}'::regclass`)).r).toBe(true)
      expect((await one(db, `SELECT count(*)::int AS n FROM pg_policies WHERE tablename='${t}'`)).n).toBe(0)
      for (const who of ["anon", "authenticated"]) {
        expect((await one(db, `SELECT has_table_privilege('${who}', 'public.${t}', 'SELECT') AS h`)).h, `${who} ${t}`).toBe(false)
      }
    }
    for (const f of FUNCTIONS) {
      for (const who of ["anon", "authenticated"]) {
        expect((await one(db, `SELECT has_function_privilege('${who}', 'public.${f}', 'EXECUTE') AS h`)).h, `${who} ${f}`).toBe(false)
      }
      expect((await one(db, `SELECT has_function_privilege('service_role', 'public.${f}', 'EXECUTE') AS h`)).h, f).toBe(true)
    }
  }, 60_000)

  it("settings seed: one row, caps_enabled=false, alerts_enabled=false, thresholds equal the spec §7 defaults", async () => {
    const db = await fresh98()
    const r = await rows(db, "SELECT * FROM api_v2_money_settings")
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 1, caps_enabled: false, alerts_enabled: false })
    expect(r[0].thresholds).toEqual(DEFAULT_THRESHOLDS)
    await db.exec("UPDATE api_v2_money_settings SET caps_enabled = true")
    await db.exec(migration())
    expect((await one(db, "SELECT caps_enabled FROM api_v2_money_settings")).caps_enabled).toBe(true)
  }, 60_000)

  it("reserve with caps off -> {ok:true, skipped:true} and no ledger row", async () => {
    const db = await fresh98()
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    expect(await reserve(db, u, k, "r1", 5)).toEqual({ ok: true, skipped: true })
    expect(await ledgerCount(db)).toBe(0)
  }, 60_000)

  it("reserve under both caps -> reserved row; same (key,kind,reference) again -> same ledger_id, existing:true, no new row", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await capKey(db, k, 50)
    await capUser(db, u, 80)
    const a = await reserve(db, u, k, "r1", 5)
    expect(a.ok).toBe(true)
    expect(typeof a.ledger_id).toBe("string")
    const b = await reserve(db, u, k, "r1", 5)
    expect(b).toMatchObject({ ok: true, ledger_id: a.ledger_id, existing: true })
    expect(await ledgerCount(db)).toBe(1)
    // final review I1: the existing row's age (seconds since its last change) comes back, so a stale one can be told apart
    expect(typeof b.age_s).toBe("number")
    expect(b.age_s).toBeGreaterThanOrEqual(0)
    await db.exec(`UPDATE api_v2_spend_ledger SET updated_at = now() - interval '10 minutes' WHERE id = '${a.ledger_id}'`)
    const c = await reserve(db, u, k, "r1", 5)
    expect(c.age_s).toBeGreaterThanOrEqual(590)
    expect((await one(db, "SELECT state FROM api_v2_spend_ledger")).state).toBe("reserved")
  }, 60_000)

  it("over the key cap -> scope key; over the user cap -> scope user; the stricter cap wins", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await capKey(db, k, 10)
    expect((await reserve(db, u, k, "a", 8)).ok).toBe(true)
    expect(await reserve(db, u, k, "b", 3)).toEqual({ ok: false, code: "cap_reached", scope: "key" })
    expect((await reserve(db, u, k, "c", 2)).ok).toBe(true)
    const u2 = await mkUser(db)
    const k2 = await mkKey(db, u2)
    await capKey(db, k2, 100)
    await capUser(db, u2, 6)
    expect(await reserve(db, u2, k2, "a", 7)).toEqual({ ok: false, code: "cap_reached", scope: "user" })
    expect((await reserve(db, u2, k2, "b", 6)).ok).toBe(true)
  }, 60_000)

  it("the user cap spans all keys of the person", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k1 = await mkKey(db, u)
    const k2 = await mkKey(db, u, { type: "commission" })
    await capUser(db, u, 10)
    expect((await reserve(db, u, k1, "a", 6)).ok).toBe(true)
    expect(await reserve(db, u, k2, "b", 5)).toEqual({ ok: false, code: "cap_reached", scope: "user" })
    expect((await reserve(db, u, k2, "c", 4)).ok).toBe(true)
  }, 60_000)

  it("released rows do not count; reserved and spent do; yesterday's rows do not count (UTC day)", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await capKey(db, k, 10)
    await reserve(db, u, k, "a", 6)
    await call(db, "api_v2_spend_settle", k, "airtime", "a", "released", null)
    expect((await reserve(db, u, k, "b", 9)).ok).toBe(true)
    await call(db, "api_v2_spend_settle", k, "airtime", "b", "spent", null)
    expect(await reserve(db, u, k, "c", 2)).toMatchObject({ ok: false, scope: "key" })
    await db.exec("UPDATE api_v2_spend_ledger SET day = day - 1")
    expect((await reserve(db, u, k, "d", 10)).ok).toBe(true)
  }, 60_000)

  // PGlite runs one statement at a time on one connection, so this is NOT a real race: it pins the arithmetic only.
  // The lock itself is pinned by the text test above (lock before sum) and must be checked with two sessions in the dry run.
  it("concurrency: 20 reserves of 1.00 against a 10.00 cap leave exactly 10 reserved", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await capKey(db, k, 10)
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(db, u, k, `p${i}`, 1)))
    expect(out.filter((r) => r.ok).length).toBe(10)
    expect(await ledgerCount(db, "state = 'reserved'")).toBe(10)
  }, 60_000)

  it("reserve refuses bad input: test key, someone else's key, amount 0, unknown kind", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const other = await mkUser(db, "Kofi")
    const test = await mkKey(db, u, { env: "test" })
    const theirs = await mkKey(db, other)
    const k = await mkKey(db, u)
    for (const r of [
      await reserve(db, u, test, "a", 1),
      await reserve(db, u, theirs, "a", 1),
      await reserve(db, u, k, "a", 0),
      await reserve(db, u, k, "a", 1, "sms"),
    ]) {
      expect(r).toEqual({ ok: false, code: "bad_input" })
    }
    expect(await ledgerCount(db)).toBe(0)
  }, 60_000)

  it("settle: reserved->spent (amount may drop, never rise); reserved->released; settling spent/released/missing is a no-op", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await reserve(db, u, k, "a", 10, "data_bulk")
    expect(await call(db, "api_v2_spend_settle", k, "data_bulk", "a", "spent", 12)).toEqual({ ok: true, changed: true })
    expect(Number((await one(db, "SELECT amount FROM api_v2_spend_ledger")).amount)).toBe(10)
    expect(await call(db, "api_v2_spend_settle", k, "data_bulk", "a", "released", null)).toEqual({ ok: true, changed: false })
    await reserve(db, u, k, "b", 10, "data_bulk")
    await call(db, "api_v2_spend_settle", k, "data_bulk", "b", "spent", 4)
    expect(Number((await one(db, "SELECT amount FROM api_v2_spend_ledger WHERE reference = 'b'")).amount)).toBe(4)
    await reserve(db, u, k, "c", 3)
    expect(await call(db, "api_v2_spend_settle", k, "airtime", "c", "released", null)).toEqual({ ok: true, changed: true })
    expect(await call(db, "api_v2_spend_settle", k, "airtime", "missing", "spent", null)).toEqual({ ok: true, changed: false })
    expect(await call(db, "api_v2_spend_settle", k, "airtime", "c", "bogus", null)).toEqual({ ok: false, code: "bad_input" })
  }, 60_000)

  it("set_spend_cap: key owner ok; someone else's key not_found; test key not_live; bad caps refused; null removes; audit only on change", async () => {
    const db = await fresh98()
    const u = await mkUser(db)
    const other = await mkUser(db, "Kofi")
    const k = await mkKey(db, u)
    const test = await mkKey(db, u, { env: "test" })
    expect(await call(db, "api_v2_set_spend_cap", "key", k, 25, u)).toEqual({ ok: true, changed: true })
    expect(await call(db, "api_v2_set_spend_cap", "key", k, 25, u)).toEqual({ ok: true, changed: false })
    expect(await call(db, "api_v2_set_spend_cap", "key", k, 25, other)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_set_spend_cap", "key", test, 25, u)).toEqual({ ok: false, code: "not_live" })
    for (const bad of [0, -1, 1000001]) expect(await call(db, "api_v2_set_spend_cap", "key", k, bad, u)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_spend_cap", "key", k, 25, null)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_spend_cap", "key", k, null, u)).toEqual({ ok: true, changed: true })
    expect(await call(db, "api_v2_set_spend_cap", "key", k, null, u)).toEqual({ ok: true, changed: false })
    expect(await auditCount(db, "api_spend_cap_set")).toBe(1)
    expect(await auditCount(db, "api_spend_cap_removed")).toBe(1)
    expect(await call(db, "api_v2_set_spend_cap", "user", u, 40, ACTOR)).toEqual({ ok: true, changed: true })
    expect(await call(db, "api_v2_set_spend_cap", "user", "00000000-0000-0000-0000-00000000dead", 40, ACTOR)).toEqual({ ok: false, code: "not_found" })
    expect(await call(db, "api_v2_set_spend_cap", "team", u, 40, ACTOR)).toEqual({ ok: false, code: "bad_input" })
    const audit = await one(db, "SELECT target_user_id, new_value FROM admin_audit_log WHERE action = 'api_spend_cap_set' ORDER BY created_at DESC LIMIT 1")
    expect(audit.target_user_id).toBe(u)
    expect(audit.new_value).toMatchObject({ scope: "user", cap: 40 })
  }, 60_000)

  it("set_money_settings: actor required; audited once per change; thresholds merged, null keeps them", async () => {
    const db = await fresh98()
    expect(await call(db, "api_v2_set_money_settings", true, false, null, null)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_money_settings", true, false, null, ACTOR)).toEqual({ ok: true, changed: true })
    expect(await call(db, "api_v2_set_money_settings", true, false, null, ACTOR)).toEqual({ ok: true, changed: false })
    expect(await call(db, "api_v2_set_money_settings", true, true, '{"cap_hits": 5}', ACTOR)).toEqual({ ok: true, changed: true })
    const s = await one(db, "SELECT caps_enabled, alerts_enabled, thresholds FROM api_v2_money_settings")
    expect(s).toMatchObject({ caps_enabled: true, alerts_enabled: true })
    expect(s.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, cap_hits: 5 })
    expect(await auditCount(db, "api_money_settings")).toBe(2)
  }, 60_000)

  it("spend_today: spent per key and per user (reserved + spent), both caps, refusals today; never counts released", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k1 = await mkKey(db, u)
    const k2 = await mkKey(db, u, { type: "commission" })
    await capKey(db, k1, 30)
    await capUser(db, u, 50)
    await reserve(db, u, k1, "a", 5)
    await reserve(db, u, k2, "b", 7)
    await call(db, "api_v2_spend_settle", k2, "airtime", "b", "spent", null)
    await reserve(db, u, k2, "c", 9)
    await call(db, "api_v2_spend_settle", k2, "airtime", "c", "released", null)
    await db.exec(`INSERT INTO api_v2_logs(key_id, user_id, method, endpoint, status_code, environment, error_reason) VALUES ('${k1}', '${u}', 'POST', '/api/v2/airtime/purchase', 402, 'live', 'daily_limit')`)
    const t = await call(db, "api_v2_spend_today", u)
    expect(Number(t.user.spent)).toBe(12)
    expect(Number(t.user.cap)).toBe(50)
    const byKey = Object.fromEntries(t.keys.map((x: any) => [x.key_id, x]))
    expect(Number(byKey[k1].spent)).toBe(5)
    expect(Number(byKey[k1].cap)).toBe(30)
    expect(Number(byKey[k2].spent)).toBe(7)
    expect(byKey[k2].cap).toBeNull()
    expect(t.refusals_today).toBe(1)
  }, 60_000)

  it("risk_scan returns [] while alerts are off", async () => {
    const db = await fresh98()
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    for (let i = 0; i < 5; i++) await mkOrder(db, { user: u, key: k, price: 100 })
    expect(await call(db, "api_v2_risk_scan", null)).toEqual([])
  }, 60_000)

  it("risk_scan with alerts on: each of the five signals fires on its scenario and not just below it", async () => {
    const db = await fresh98({ alerts: true })
    const signalsFor = async (u: string) => ((await call(db, "api_v2_risk_scan", null)) as any[]).filter((a) => a.user_id === u).map((a) => a.signal).sort()

    const nk = await mkUser(db)
    const nkKey = await mkKey(db, nk)
    await mkOrder(db, { user: nk, key: nkKey, price: 100 })
    expect(await signalsFor(nk)).not.toContain("new_key_big_spend")
    await mkOrder(db, { user: nk, key: nkKey, price: 1 })
    expect(await signalsFor(nk)).toContain("new_key_big_spend")

    const sp = await mkUser(db)
    const spKey = await mkKey(db, sp, { at: "now() - interval '30 days'" })
    for (let d = 1; d <= 7; d++) await mkOrder(db, { user: sp, key: spKey, price: 70, at: `now() - interval '${d} days'` })
    await mkOrder(db, { user: sp, key: spKey, price: 211 })
    expect(await signalsFor(sp)).toContain("spend_spike")
    const sp2 = await mkUser(db)
    const sp2Key = await mkKey(db, sp2, { at: "now() - interval '30 days'" })
    for (let d = 1; d <= 7; d++) await mkOrder(db, { user: sp2, key: sp2Key, price: 80, at: `now() - interval '${d} days'` })
    await mkOrder(db, { user: sp2, key: sp2Key, price: 230 })
    expect(await signalsFor(sp2)).not.toContain("spend_spike")

    const fo = await mkUser(db)
    const foKey = await mkKey(db, fo, { at: "now() - interval '30 days'" })
    for (let i = 0; i < 30; i++) await mkOrder(db, { user: fo, key: foKey, price: 1, phone: `02400000${String(i).padStart(2, "0")}` })
    expect(await signalsFor(fo)).not.toContain("recipient_fanout")
    await mkOrder(db, { user: fo, key: foKey, price: 1, phone: "0249999999" })
    expect(await signalsFor(fo)).toContain("recipient_fanout")

    const ch = await mkUser(db)
    const chKey = await mkKey(db, ch, { at: "now() - interval '30 days'" })
    const refuse = () =>
      db.exec(`INSERT INTO api_v2_logs(key_id, user_id, method, endpoint, status_code, environment, error_reason) VALUES ('${chKey}', '${ch}', 'POST', '/api/v2/data/purchase', 402, 'live', 'daily_limit')`)
    await refuse()
    await refuse()
    expect(await signalsFor(ch)).not.toContain("cap_hits")
    await refuse()
    expect(await signalsFor(ch)).toContain("cap_hits")
    // final review M3 (re-graded): cap_hits dedups per person per DAY (a developer's own low limit cannot page admins hourly)
    const chAlert = ((await call(db, "api_v2_risk_scan", null)) as any[]).find((a) => a.user_id === ch && a.signal === "cap_hits")
    const dayStart = (await one(db, "SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS d")).d
    expect(new Date(chAlert.bucket).getTime()).toBe(new Date(dayStart).getTime())

    const fb = await mkUser(db)
    const fbKey = await mkKey(db, fb, { at: "now() - interval '30 days'" })
    for (let i = 0; i < 10; i++) await mkOrder(db, { user: fb, key: fbKey, price: 1, status: "failed", phone: "0241111111" })
    for (let i = 0; i < 10; i++) await mkOrder(db, { user: fb, key: fbKey, price: 1, phone: "0241111111" })
    expect(await signalsFor(fb)).not.toContain("failure_burst")
    await db.exec(`UPDATE api_orders SET status = 'failed' WHERE id = (SELECT id FROM api_orders WHERE user_id = '${fb}' AND status = 'completed' LIMIT 1)`)
    expect(await signalsFor(fb)).toContain("failure_burst")

    const all = (await call(db, "api_v2_risk_scan", null)) as any[]
    for (const a of all) {
      expect(typeof a.bucket).toBe("string")
      expect(JSON.stringify(a.details)).not.toMatch(/024\d{7}/)
    }
  }, 120_000)

  it("risk_scan ignores test keys", async () => {
    const db = await fresh98({ alerts: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u, { env: "test" })
    await mkOrder(db, { user: u, key: k, price: 500 })
    expect(((await call(db, "api_v2_risk_scan", null)) as any[]).filter((a) => a.user_id === u)).toEqual([])
  }, 60_000)

  it("risk_alerts: UNIQUE (user_id, signal, bucket) dedups", async () => {
    const db = await fresh98()
    const u = await mkUser(db)
    const ins = `INSERT INTO api_v2_risk_alerts(user_id, signal, bucket, details) VALUES ('${u}', 'cap_hits', date_trunc('hour', now()), '{}') ON CONFLICT DO NOTHING`
    await db.exec(ins)
    await db.exec(ins)
    expect((await one(db, "SELECT count(*)::int AS n FROM api_v2_risk_alerts")).n).toBe(1)
  }, 60_000)

  // ---- review fixes (Task 1 gate) ----
  it("C1: a released reference is re-checked against the cap and counted again; never handed back as 'existing'", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await capKey(db, k, 10)
    await reserve(db, u, k, "R", 4)
    await call(db, "api_v2_spend_settle", k, "airtime", "R", "released", null)
    await reserve(db, u, k, "fill", 10)
    expect(await reserve(db, u, k, "R", 4)).toEqual({ ok: false, code: "cap_reached", scope: "key" })
    await call(db, "api_v2_spend_settle", k, "airtime", "fill", "released", null)
    const again = await reserve(db, u, k, "R", 7)
    expect(again.ok).toBe(true)
    expect(again.existing).toBeUndefined()
    const r = await one(db, "SELECT state, amount FROM api_v2_spend_ledger WHERE reference = 'R'")
    expect(r.state).toBe("reserved")
    expect(Number(r.amount)).toBe(7)
    expect(await call(db, "api_v2_spend_settle", k, "airtime", "R", "spent", null)).toEqual({ ok: true, changed: true })
  }, 60_000)

  it("C1: an existing reserved or spent row comes back as existing with its state (the caller must not settle it)", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    await reserve(db, u, k, "R", 4)
    expect(await reserve(db, u, k, "R", 4)).toMatchObject({ ok: true, existing: true, state: "reserved" })
    await call(db, "api_v2_spend_settle", k, "airtime", "R", "spent", null)
    expect(await reserve(db, u, k, "R", 4)).toMatchObject({ ok: true, existing: true, state: "spent" })
  }, 60_000)

  it("I1: new_key_big_spend fires for an older new key even when the person has a newer unspent key", async () => {
    const db = await fresh98({ alerts: true })
    const u = await mkUser(db)
    const older = await mkKey(db, u, { at: "now() - interval '2 hours'" })
    await mkKey(db, u, { type: "commission", at: "now() - interval '1 hour'" })
    await mkOrder(db, { user: u, key: older, price: 150 })
    const sig = ((await call(db, "api_v2_risk_scan", null)) as any[]).filter((a) => a.user_id === u).map((a) => a.signal)
    expect(sig).toContain("new_key_big_spend")
  }, 60_000)

  it("M1/M2: an amount or cap that rounds to 0.00 is bad_input, never a raised error", async () => {
    const db = await fresh98({ caps: true })
    const u = await mkUser(db)
    const k = await mkKey(db, u)
    expect(await reserve(db, u, k, "tiny", 0.004)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_spend_cap", "key", k, 0.001, u)).toEqual({ ok: false, code: "bad_input" })
  }, 60_000)

  it("M3/M4: settings row missing -> not_found; thresholds must be known keys with positive numbers", async () => {
    const db = await fresh98()
    expect(await call(db, "api_v2_set_money_settings", null, null, '{"cap_hits": "three"}', ACTOR)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_money_settings", null, null, '{"cap_hits": null}', ACTOR)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_money_settings", null, null, '{"made_up": 1}', ACTOR)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_money_settings", null, null, '{"cap_hits": 0}', ACTOR)).toEqual({ ok: false, code: "bad_input" })
    expect(await call(db, "api_v2_set_money_settings", null, null, '{"cap_hits": 4}', ACTOR)).toEqual({ ok: true, changed: true })
    await db.exec("DELETE FROM api_v2_money_settings")
    expect(await call(db, "api_v2_set_money_settings", true, null, null, ACTOR)).toEqual({ ok: false, code: "not_found" })
  }, 60_000)

  it("M6: spend_spike boundaries: exactly the GHS 200 floor and exactly 3x the average do not fire", async () => {
    const db = await fresh98({ alerts: true })
    const spikes = async (u: string) => ((await call(db, "api_v2_risk_scan", null)) as any[]).filter((a) => a.user_id === u && a.signal === "spend_spike").length
    const a = await mkUser(db)
    const ak = await mkKey(db, a, { at: "now() - interval '30 days'" })
    await mkOrder(db, { user: a, key: ak, price: 200 })
    expect(await spikes(a)).toBe(0) // at the floor, no history
    const b = await mkUser(db)
    const bk = await mkKey(db, b, { at: "now() - interval '30 days'" })
    for (let d = 1; d <= 7; d++) await mkOrder(db, { user: b, key: bk, price: 70, at: `now() - interval '${d} days'` })
    await mkOrder(db, { user: b, key: bk, price: 210 })
    expect(await spikes(b)).toBe(0) // exactly 3 x 70
  }, 60_000)

  it("I2: functions do not pretend to bound their own runtime (a function-level statement_timeout does not apply to the running call)", () => {
    const c = code(migration())
    const fns = c.slice(c.indexOf("CREATE OR REPLACE FUNCTION"), c.indexOf("CREATE TABLE IF NOT EXISTS"))
    expect(fns).not.toMatch(/SET statement_timeout/)
  })

  it("selftest: raises SELFTEST_OK 0198 and leaves no table or function behind", async () => {
    const db = await fresh()
    // a live key, so the selftest's reserve/cap/settle part runs (with no live key it is skipped)
    const u = await mkUser(db)
    await mkKey(db, u)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0198/)
    await db.exec("ROLLBACK")
    // with no live key it still reaches SELFTEST_OK
    const empty = await fresh()
    await expect(empty.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0198/)
    await empty.exec("ROLLBACK")
    for (const t of TABLES) expect((await one(db, `SELECT to_regclass('public.${t}') AS r`)).r).toBeNull()
    expect((await one(db, "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'api_v2_spend%' OR proname IN ('api_v2_risk_scan','api_v2_set_money_settings','api_v2_set_spend_cap')")).n).toBe(0)
  }, 60_000)
})
