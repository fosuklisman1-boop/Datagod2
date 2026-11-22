// lib/api-v2/migration-0195.test.ts
// migrations/0195_api_approval.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0195 builds on 0128 (api_v2_keys, api_v2_logs, api_v2_config) and the admin_audit_log of 0069 + 0176 (stubbed).
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0195-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0195_api_approval.sql"
const SELFTEST_FILE = "0195_api_approval.selftest.sql"
const migration = () => read(FILE)

describe("0195 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c.match(/^BEGIN;\s*$/gm)).toHaveLength(1)
    expect(c).toMatch(/SET LOCAL lock_timeout = '2s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '15s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("takes locks on live tables as late as possible: functions, then the FK tables, then hot ALTERs, indexes, backfill, and the DROP INDEX last", () => {
    const c = code(migration())
    const lastFn = c.lastIndexOf("CREATE OR REPLACE FUNCTION")
    const firstTable = c.indexOf("CREATE TABLE IF NOT EXISTS public.api_v2_access_requests")
    const lastTable = c.indexOf("CREATE TABLE IF NOT EXISTS public.api_v2_access_grants")
    const firstHot = c.search(/ALTER TABLE public\.api_v2_(config|keys|logs)\b/)
    const idxCode = c.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_request_code_key")
    const idxActive = c.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_one_active_per_slot")
    const idxPending = c.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_one_pending_per_slot")
    const backfill = c.indexOf("WHERE environment = 'live' AND status = 'pending' AND request_code IS NULL")
    const drop = c.indexOf("DROP INDEX IF EXISTS public.api_v2_keys_one_live_per_type")
    for (const n of [lastFn, firstTable, lastTable, firstHot, idxCode, idxActive, idxPending, backfill, drop]) expect(n).toBeGreaterThan(0)
    expect(firstHot).toBeGreaterThan(lastFn)
    expect(firstTable).toBeGreaterThan(lastFn)
    expect(firstHot).toBeGreaterThan(lastTable)
    expect(idxCode).toBeGreaterThan(firstHot)
    expect(backfill).toBeGreaterThan(Math.max(idxCode, idxActive, idxPending))
    expect(drop).toBeGreaterThan(Math.max(idxActive, idxPending, backfill))
    // nothing but the final COMMIT follows the DROP INDEX
    expect(c.slice(drop).replace(/^[^;]*;\s*/, "").trim()).toBe("COMMIT;")
    // no function needs a table to exist when it is created
    expect(c).not.toMatch(/%ROWTYPE/)
  })

  it("the header lists every lock: table, mode, what it blocks, held until the end, quiet window, harmless lock timeout", () => {
    const m = migration()
    const header = m.slice(0, m.indexOf("\nBEGIN;"))
    expect(header).toMatch(/LOCKS[\s\S]*api_v2_config[^\n]*ACCESS EXCLUSIVE/)
    expect(header).toMatch(/api_v2_keys[^\n]*ACCESS EXCLUSIVE/)
    expect(header).toMatch(/api_v2_logs[^\n]*ACCESS EXCLUSIVE/)
    expect(header).toMatch(/auth\.users[^\n]*SHARE ROW EXCLUSIVE/)
    expect(header).toMatch(/until the (final )?statement that ends the transaction|until the transaction ends/i)
    expect(header).toMatch(/quiet window/)
    expect(header).toMatch(/lock timeout[^\n]*(harmless|safe)[^\n]*retry/i)
  })

  it("decision functions never take a plain FOR UPDATE (FOR NO KEY UPDATE does not conflict with the key-share of api_v2_logs inserts)", () => {
    const c = code(migration())
    expect(c).not.toMatch(/\bFOR\s+UPDATE\b/)
    expect((c.match(/\bFOR NO KEY UPDATE\b/g) ?? []).length).toBe(4)
  })

  it("the run string has no COMMIT, no bare END; in the self-test, and ends by raising", () => {
    const run = buildRunString(migration(), read(SELFTEST_FILE))
    const s = code(run)
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0195[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("the builder refuses a migration without its COMMIT line", () => {
    expect(() => buildRunString(migration().replace(/^COMMIT;$/m, ""), read(SELFTEST_FILE))).toThrow(/no COMMIT/)
  })

  it("creates both new indexes before dropping the old one, and the header records the pre-checks and source census", () => {
    const m = migration()
    const iActive = m.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_one_active_per_slot")
    const iPending = m.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_one_pending_per_slot")
    const iDrop = m.indexOf("DROP INDEX IF EXISTS public.api_v2_keys_one_live_per_type")
    expect(iActive).toBeGreaterThan(0)
    expect(iPending).toBeGreaterThan(0)
    expect(iDrop).toBeGreaterThan(Math.max(iActive, iPending))
    expect(m).toContain("PRE-CHECKS")
    expect(m).toMatch(/SELECT source, status, count\(\*\) FROM public\.transactions WHERE type = 'credit'/)
  })

  it("every SECURITY DEFINER function pins search_path and the file revokes from PUBLIC, anon, authenticated", () => {
    const c = code(migration())
    const defs = c.match(/SECURITY DEFINER/g) ?? []
    expect(defs.length).toBe(7)
    expect((c.match(/SET search_path = public, pg_temp/g) ?? []).length).toBe(7)
    expect((c.match(/FROM PUBLIC, anon, authenticated/g) ?? []).length).toBeGreaterThanOrEqual(9)
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
// auth.users with a real FK target; public.users with only the columns 0195 reads; admin_audit_log as 0069 + 0176 leave it.
const STUBS = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE TABLE public.users(id uuid PRIMARY KEY REFERENCES auth.users(id), role text, is_suspended boolean NOT NULL DEFAULT false);
  CREATE TABLE public.admin_audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid, action text NOT NULL,
    target_user_id uuid, old_value jsonb, new_value jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, source text,
    amount numeric, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.api_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.hubtel_data_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.airtime_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.hubtel_bill_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.results_checker_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.afa_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
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
  return db
}
async function fresh94(): Promise<any> {
  const db = await fresh()
  await db.exec(migration())
  return db
}

const ACTOR = "00000000-0000-0000-0000-0000000000a1"
const CODE_RE = /^API-[2-9A-HJKMNP-Z]{6}$/

async function rows(db: any, sql: string): Promise<any[]> {
  return (await db.query(sql)).rows
}
async function mkUser(db: any, role = "dealer", suspended = false): Promise<string> {
  const id = (await rows(db, "SELECT gen_random_uuid() AS id"))[0].id
  await db.exec(`INSERT INTO auth.users(id) VALUES ('${id}')`)
  await db.exec(`INSERT INTO public.users(id, role, is_suspended) VALUES ('${id}', '${role}', ${suspended})`)
  return id
}
async function mkKey(
  db: any,
  user: string,
  o: { status?: string; type?: string; env?: string; limits?: unknown } = {},
): Promise<string> {
  const lim = o.limits === undefined ? "NULL" : `'${JSON.stringify(o.limits)}'::jsonb`
  return (
    await rows(
      db,
      `INSERT INTO api_v2_keys(user_id, key_type, environment, status, name, key_hash, key_prefix, rate_limits)
       VALUES ('${user}', '${o.type ?? "standard"}', '${o.env ?? "live"}', '${o.status ?? "pending"}', 'k',
               'h-' || gen_random_uuid()::text, 'pfx', ${lim}) RETURNING id`,
    )
  )[0].id
}
async function setAllowed(db: any, roles: string[]): Promise<void> {
  await db.exec(`UPDATE api_v2_config SET allowed_roles = ARRAY[${roles.map((r) => `'${r}'`).join(",")}]::text[]`)
}
async function call(db: any, fn: string, ...args: (string | null)[]): Promise<any> {
  const a = args.map((x) => (x === null ? "NULL" : `'${x}'`)).join(", ")
  return (await rows(db, `SELECT public.${fn}(${a}) AS r`))[0].r
}
async function key(db: any, id: string): Promise<any> {
  return (await rows(db, `SELECT * FROM api_v2_keys WHERE id = '${id}'`))[0]
}
async function auditCount(db: any, action?: string): Promise<number> {
  const w = action ? `WHERE action = '${action}'` : ""
  return (await rows(db, `SELECT count(*)::int AS n FROM admin_audit_log ${w}`))[0].n
}
async function fails(db: any, sql: string, msg?: RegExp): Promise<void> {
  let err: any = null
  try {
    await db.exec(sql)
  } catch (e) {
    err = e
  }
  expect(err, `expected failure: ${sql}`).not.toBeNull()
  if (msg) expect(String(err.message)).toMatch(msg)
}

describe.skipIf(!PGliteCtor)("0195 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await mkUser(db, "dealer")
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0195/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.api_v2_access_requests') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT to_regclass('public.api_v2_access_grants') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT to_regprocedure('public.api_v2_approve_key(uuid,uuid)') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT count(*)::int AS n FROM api_v2_keys")).rows[0].n).toBe(0)
    expect((await db.query("SELECT count(*)::int AS n FROM admin_audit_log")).rows[0].n).toBe(0)
    // the old index is back, the new ones are gone
    expect((await rows(db, "SELECT indexname FROM pg_indexes WHERE tablename = 'api_v2_keys' AND indexname LIKE 'api_v2_keys_one_%' ORDER BY 1")).map((r) => r.indexname)).toEqual(["api_v2_keys_one_live_per_type"])
  }, 60_000)

  it("the self-test also passes against the already-applied schema (run alone after the real apply)", async () => {
    const db = await fresh94()
    await mkUser(db, "dealer")
    const st = read(SELFTEST_FILE)
    const doBlock = st.split("\n").slice(st.split("\n").findIndex((l) => /^DO\b/.test(l))).join("\n")
    await db.exec("BEGIN")
    await expect(db.exec(doBlock)).rejects.toThrow(/^SELFTEST_OK 0195/)
    await db.exec("ROLLBACK")
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await fresh94()
    await db.exec(migration())
    expect((await rows(db, "SELECT count(*)::int AS n FROM api_v2_config"))[0].n).toBe(1)
  }, 60_000)

  it("adds the columns and tables of section 7", async () => {
    const db = await fresh94()
    const cols = async (t: string) =>
      (await rows(db, `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'`)).map((r) => r.column_name)
    expect(await cols("api_v2_config")).toContain("approval_whatsapp")
    expect(await cols("api_v2_logs")).toContain("error_reason")
    for (const c of ["request_code", "rejected_at", "rejected_by", "reject_reason"]) expect(await cols("api_v2_keys")).toContain(c)
    expect([...(await cols("api_v2_access_requests"))].sort()).toEqual(
      ["id", "user_id", "request_code", "status", "reason", "created_at", "decided_at", "decided_by"].sort(),
    )
    expect(await cols("api_v2_access_grants")).toEqual(expect.arrayContaining(["user_id", "granted_by", "granted_at", "request_id"]))
  }, 60_000)

  it("indexes: active + pending in one slot allowed; second active refused; second pending refused (23505)", async () => {
    const db = await fresh94()
    const u = await mkUser(db)
    await mkKey(db, u, { status: "active" })
    await mkKey(db, u, { status: "pending" })
    await fails(db, `INSERT INTO api_v2_keys(user_id,key_type,environment,status,name,key_hash,key_prefix) VALUES ('${u}','standard','live','active','k','h-${Math.random()}','p')`, /duplicate key|23505|unique/i)
    await fails(db, `INSERT INTO api_v2_keys(user_id,key_type,environment,status,name,key_hash,key_prefix) VALUES ('${u}','standard','live','pending','k','h-${Math.random()}','p')`, /duplicate key|23505|unique/i)
    // a different slot is independent
    await mkKey(db, u, { status: "active", env: "test" })
    await mkKey(db, u, { status: "active", type: "commission" })
    const err = await db.exec(`INSERT INTO api_v2_keys(user_id,key_type,environment,status,name,key_hash,key_prefix) VALUES ('${u}','standard','live','pending','k','h-x','p')`).catch((e: any) => e)
    expect(err.code).toBe("23505")
  }, 60_000)

  it("backfill: existing pending live key gets /^API-[A-Z0-9]{6}$/; active keys get none", async () => {
    const db = await fresh()
    const u = await mkUser(db)
    const u2 = await mkUser(db)
    const pendingLive = await mkKey(db, u, { status: "pending", env: "live" })
    const pendingTest = await mkKey(db, u, { status: "pending", env: "test" })
    const active = await mkKey(db, u2, { status: "active", env: "live" })
    await db.exec(migration())
    const p = await key(db, pendingLive)
    expect(p.request_code).toMatch(/^API-[A-Z0-9]{6}$/)
    expect(p.request_code).toMatch(CODE_RE) // and only the allowed alphabet (no 0, O, 1, I, L)
    expect((await key(db, active)).request_code).toBeNull()
    expect((await key(db, pendingTest)).request_code).toBeNull()
  }, 60_000)

  it("codes: 300 generated codes all use the restricted alphabet and are not repeated", async () => {
    const db = await fresh94()
    const codes = (await rows(db, "SELECT public.api_v2_new_request_code() AS c FROM generate_series(1, 300)")).map((r) => r.c)
    for (const c of codes) expect(c).toMatch(CODE_RE)
    expect(new Set(codes).size).toBe(codes.length)
  }, 60_000)

  it("approve_key: old -> revoked, new -> active, limits {\"purchase\":50} copied", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    const old = await mkKey(db, u, { status: "active", limits: { purchase: 50 } })
    const neu = await mkKey(db, u, { status: "pending" })
    const r = await call(db, "api_v2_approve_key", neu, ACTOR)
    expect(r).toEqual({ ok: true, user_id: u, key_type: "standard", replaced_key_id: old })
    const o = await key(db, old)
    expect(o.status).toBe("revoked")
    expect(o.revoked_by).toBe(ACTOR)
    expect(o.revoked_at).not.toBeNull()
    expect(o.rejected_at).toBeNull()
    const n = await key(db, neu)
    expect(n.status).toBe("active")
    expect(n.approved_by).toBe(ACTOR)
    expect(n.approved_at).not.toBeNull()
    expect(n.rate_limits).toEqual({ purchase: 50 })
  }, 60_000)

  it("approve_key: existing overrides on new key kept", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    await mkKey(db, u, { status: "active", limits: { purchase: 50 } })
    const neu = await mkKey(db, u, { status: "pending", limits: { purchase: 7, bulk: 3 } })
    expect((await call(db, "api_v2_approve_key", neu, ACTOR)).ok).toBe(true)
    expect((await key(db, neu)).rate_limits).toEqual({ purchase: 7, bulk: 3 })
  }, 60_000)

  it("approve_key: suspended -> suspended, not_eligible -> not_eligible; in both cases old key still active", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const s = await mkUser(db, "dealer", true)
    const sOld = await mkKey(db, s, { status: "active" })
    const sNew = await mkKey(db, s, { status: "pending" })
    expect(await call(db, "api_v2_approve_key", sNew, ACTOR)).toEqual({ ok: false, code: "suspended" })
    expect((await key(db, sOld)).status).toBe("active")
    expect((await key(db, sNew)).status).toBe("pending")

    const e = await mkUser(db, "user")
    const eOld = await mkKey(db, e, { status: "active" })
    const eNew = await mkKey(db, e, { status: "pending" })
    expect(await call(db, "api_v2_approve_key", eNew, ACTOR)).toEqual({ ok: false, code: "not_eligible" })
    expect((await key(db, eOld)).status).toBe("active")
    expect((await key(db, eNew)).status).toBe("pending")
    expect(await auditCount(db)).toBe(0)
  }, 60_000)

  it("approve_key: a grant beats a disallowed role, but never a suspension", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "user")
    await db.exec(`INSERT INTO api_v2_access_grants(user_id, granted_by) VALUES ('${u}', '${ACTOR}')`)
    const k = await mkKey(db, u, { status: "pending" })
    expect((await call(db, "api_v2_approve_key", k, ACTOR)).ok).toBe(true)
    const s = await mkUser(db, "user", true)
    await db.exec(`INSERT INTO api_v2_access_grants(user_id, granted_by) VALUES ('${s}', '${ACTOR}')`)
    const k2 = await mkKey(db, s, { status: "pending" })
    expect(await call(db, "api_v2_approve_key", k2, ACTOR)).toEqual({ ok: false, code: "suspended" })
  }, 60_000)

  it("approve_key: a missing key is not_found, a NULL actor is refused", async () => {
    const db = await fresh94()
    expect(await call(db, "api_v2_approve_key", "00000000-0000-0000-0000-00000000dead", ACTOR)).toEqual({ ok: false, code: "not_found" })
    await fails(db, `SELECT public.api_v2_approve_key('00000000-0000-0000-0000-00000000dead', NULL)`, /actor is required/)
    await fails(db, `SELECT public.api_v2_reject_key('00000000-0000-0000-0000-00000000dead', NULL, 'nope no')`, /actor is required/)
    await fails(db, `SELECT public.api_v2_approve_access('00000000-0000-0000-0000-00000000dead', NULL)`, /actor is required/)
    await fails(db, `SELECT public.api_v2_reject_access('00000000-0000-0000-0000-00000000dead', NULL, 'nope no')`, /actor is required/)
    await fails(db, `SELECT public.api_v2_remove_grant('00000000-0000-0000-0000-00000000dead', NULL, 'nope no')`, /actor is required/)
  }, 60_000)

  it("approve_key twice -> second is stale", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    const k = await mkKey(db, u, { status: "pending" })
    expect((await call(db, "api_v2_approve_key", k, ACTOR)).ok).toBe(true)
    expect(await call(db, "api_v2_approve_key", k, ACTOR)).toEqual({ ok: false, code: "stale" })
    expect(await auditCount(db, "api_key_approve")).toBe(1)
  }, 60_000)

  it("approve_key after the active key was revoked by the user -> ok, replaced_key_id null", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    const old = await mkKey(db, u, { status: "active", limits: { purchase: 9 } })
    const neu = await mkKey(db, u, { status: "pending" })
    await db.exec(`UPDATE api_v2_keys SET status = 'revoked', revoked_at = now(), revoked_by = '${u}' WHERE id = '${old}'`)
    const r = await call(db, "api_v2_approve_key", neu, ACTOR)
    expect(r).toEqual({ ok: true, user_id: u, key_type: "standard", replaced_key_id: null })
    expect((await key(db, neu)).status).toBe("active")
    expect((await key(db, neu)).rate_limits).toBeNull()
  }, 60_000)

  it("approve_key on a revoked (rejected or user-cancelled) pending key -> stale", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    const k = await mkKey(db, u, { status: "pending" })
    await db.exec(`UPDATE api_v2_keys SET status = 'revoked' WHERE id = '${k}'`)
    expect(await call(db, "api_v2_approve_key", k, ACTOR)).toEqual({ ok: false, code: "stale" })
  }, 60_000)

  it("approve_key leaves other slots alone", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    const otherType = await mkKey(db, u, { status: "active", type: "commission" })
    const testKey = await mkKey(db, u, { status: "active", env: "test" })
    const neu = await mkKey(db, u, { status: "pending" })
    expect((await call(db, "api_v2_approve_key", neu, ACTOR)).replaced_key_id).toBeNull()
    expect((await key(db, otherType)).status).toBe("active")
    expect((await key(db, testKey)).status).toBe("active")
  }, 60_000)

  it("reject_key: revoked + rejected_at/by/reason; active key untouched; reason of 2 or 201 chars -> bad_reason", async () => {
    const db = await fresh94()
    const u = await mkUser(db, "dealer")
    const act = await mkKey(db, u, { status: "active" })
    const pen = await mkKey(db, u, { status: "pending" })
    expect(await call(db, "api_v2_reject_key", pen, ACTOR, "ab")).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_reject_key", pen, ACTOR, "x".repeat(201))).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_reject_key", pen, ACTOR, "   ab   ")).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_reject_key", pen, ACTOR, null)).toEqual({ ok: false, code: "bad_reason" })
    expect((await key(db, pen)).status).toBe("pending")
    expect(await auditCount(db)).toBe(0)
    const r = await call(db, "api_v2_reject_key", pen, ACTOR, "x".repeat(200))
    expect(r).toEqual({ ok: true, user_id: u, key_type: "standard" })
    const k = await key(db, pen)
    expect(k.status).toBe("revoked")
    expect(k.rejected_at).not.toBeNull()
    expect(k.rejected_by).toBe(ACTOR)
    expect(k.reject_reason).toBe("x".repeat(200))
    expect(k.revoked_at).not.toBeNull()
    expect((await key(db, act)).status).toBe("active")
    expect(await call(db, "api_v2_reject_key", pen, ACTOR, "already done")).toEqual({ ok: false, code: "stale" })
    expect(await call(db, "api_v2_reject_key", act, ACTOR, "not pending")).toEqual({ ok: false, code: "stale" })
    expect(await call(db, "api_v2_reject_key", "00000000-0000-0000-0000-00000000dead", ACTOR, "no such")).toEqual({ ok: false, code: "not_found" })
  }, 60_000)

  it("access: second pending request refused; approve inserts grant and creates no key; suspended refused", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "user")
    const ins = (user: string, status = "pending") =>
      `INSERT INTO api_v2_access_requests(user_id, request_code, status, reason) VALUES ('${user}', public.api_v2_new_request_code(), '${status}', 'need it') RETURNING id`
    const req = (await rows(db, ins(u)))[0].id
    await fails(db, ins(u), /duplicate key|unique/i)
    await db.exec(ins(u, "rejected")) // a closed request does not block a new one
    const before = (await rows(db, "SELECT count(*)::int AS n FROM api_v2_keys"))[0].n
    expect(await call(db, "api_v2_approve_access", req, ACTOR)).toEqual({ ok: true, user_id: u })
    expect((await rows(db, `SELECT granted_by, request_id FROM api_v2_access_grants WHERE user_id = '${u}'`))[0]).toEqual({ granted_by: ACTOR, request_id: req })
    const r = (await rows(db, `SELECT status, decided_by, decided_at FROM api_v2_access_requests WHERE id = '${req}'`))[0]
    expect(r.status).toBe("approved")
    expect(r.decided_by).toBe(ACTOR)
    expect(r.decided_at).not.toBeNull()
    expect((await rows(db, "SELECT count(*)::int AS n FROM api_v2_keys"))[0].n).toBe(before)
    expect(await call(db, "api_v2_approve_access", req, ACTOR)).toEqual({ ok: false, code: "stale" })

    const s = await mkUser(db, "user", true)
    const sreq = (await rows(db, ins(s)))[0].id
    expect(await call(db, "api_v2_approve_access", sreq, ACTOR)).toEqual({ ok: false, code: "suspended" })
    expect((await rows(db, `SELECT status FROM api_v2_access_requests WHERE id = '${sreq}'`))[0].status).toBe("pending")
    expect((await rows(db, `SELECT count(*)::int AS n FROM api_v2_access_grants WHERE user_id = '${s}'`))[0].n).toBe(0)
    expect(await call(db, "api_v2_approve_access", "00000000-0000-0000-0000-00000000dead", ACTOR)).toEqual({ ok: false, code: "not_found" })
  }, 60_000)

  it("access: approve when role is already allowed -> ok", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    const req = (await rows(db, `INSERT INTO api_v2_access_requests(user_id, request_code, status) VALUES ('${u}', public.api_v2_new_request_code(), 'pending') RETURNING id`))[0].id
    expect(await call(db, "api_v2_approve_access", req, ACTOR)).toEqual({ ok: true, user_id: u })
  }, 60_000)

  it("access: reject needs a 3-200 char reason, closes the request, writes no grant", async () => {
    const db = await fresh94()
    const u = await mkUser(db, "user")
    const req = (await rows(db, `INSERT INTO api_v2_access_requests(user_id, request_code, status) VALUES ('${u}', public.api_v2_new_request_code(), 'pending') RETURNING id`))[0].id
    expect(await call(db, "api_v2_reject_access", req, ACTOR, "no")).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_reject_access", req, ACTOR, "y".repeat(201))).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_reject_access", req, ACTOR, "  Not a known customer  ")).toEqual({ ok: true, user_id: u })
    const r = (await rows(db, `SELECT status, decided_by, reason FROM api_v2_access_requests WHERE id = '${req}'`))[0]
    expect(r).toEqual({ status: "rejected", decided_by: ACTOR, reason: "Not a known customer" })
    expect((await rows(db, "SELECT count(*)::int AS n FROM api_v2_access_grants"))[0].n).toBe(0)
    expect(await call(db, "api_v2_reject_access", req, ACTOR, "again please")).toEqual({ ok: false, code: "stale" })
    expect(await call(db, "api_v2_reject_access", "00000000-0000-0000-0000-00000000dead", ACTOR, "no such")).toEqual({ ok: false, code: "not_found" })
  }, 60_000)

  it("remove_grant: row gone, keys untouched; missing -> not_found", async () => {
    const db = await fresh94()
    const u = await mkUser(db, "user")
    await db.exec(`INSERT INTO api_v2_access_grants(user_id, granted_by) VALUES ('${u}', '${ACTOR}')`)
    const k = await mkKey(db, u, { status: "active" })
    expect(await call(db, "api_v2_remove_grant", u, ACTOR, "x")).toEqual({ ok: false, code: "bad_reason" })
    expect(await call(db, "api_v2_remove_grant", u, ACTOR, "Requested by owner")).toEqual({ ok: true, user_id: u })
    expect((await rows(db, "SELECT count(*)::int AS n FROM api_v2_access_grants"))[0].n).toBe(0)
    expect((await key(db, k)).status).toBe("active")
    expect(await call(db, "api_v2_remove_grant", u, ACTOR, "Requested by owner")).toEqual({ ok: false, code: "not_found" })
  }, 60_000)

  it("audit: each success writes exactly one admin_audit_log row; a failure writes none; no hash or phone in it", async () => {
    const db = await fresh94()
    await setAllowed(db, ["dealer"])
    const u = await mkUser(db, "dealer")
    await db.exec(`UPDATE public.users SET role = 'dealer' WHERE id = '${u}'`)
    const old = await mkKey(db, u, { status: "active" })
    const k1 = await mkKey(db, u, { status: "pending" })
    expect((await call(db, "api_v2_approve_key", k1, ACTOR)).ok).toBe(true)
    expect(await auditCount(db, "api_key_approve")).toBe(1)
    const k2 = await mkKey(db, u, { status: "pending" })
    expect((await call(db, "api_v2_reject_key", k2, ACTOR, "Not verified")).ok).toBe(true)
    expect(await auditCount(db, "api_key_reject")).toBe(1)
    const req = (await rows(db, `INSERT INTO api_v2_access_requests(user_id, request_code, status) VALUES ('${u}', public.api_v2_new_request_code(), 'pending') RETURNING id`))[0].id
    expect((await call(db, "api_v2_approve_access", req, ACTOR)).ok).toBe(true)
    expect(await auditCount(db, "api_access_approve")).toBe(1)
    const req2 = (await rows(db, `INSERT INTO api_v2_access_requests(user_id, request_code, status) VALUES ('${u}', public.api_v2_new_request_code(), 'pending') RETURNING id`))[0].id
    expect((await call(db, "api_v2_reject_access", req2, ACTOR, "Not verified")).ok).toBe(true)
    expect(await auditCount(db, "api_access_reject")).toBe(1)
    expect((await call(db, "api_v2_remove_grant", u, ACTOR, "Requested")).ok).toBe(true)
    expect(await auditCount(db, "api_grant_remove")).toBe(1)
    expect(await auditCount(db)).toBe(5)

    // failures write nothing
    await call(db, "api_v2_approve_key", k1, ACTOR) // stale
    await call(db, "api_v2_reject_key", k2, ACTOR, "x") // bad_reason
    await call(db, "api_v2_remove_grant", u, ACTOR, "Requested") // not_found
    await call(db, "api_v2_approve_access", req, ACTOR) // stale
    expect(await auditCount(db)).toBe(5)

    // shape: actor and target set; nothing resembling a hash, a prefix or a phone
    const all = await rows(db, "SELECT admin_id, target_user_id, old_value, new_value FROM admin_audit_log")
    for (const r of all) {
      expect(r.admin_id).toBe(ACTOR)
      expect(r.target_user_id).toBe(u)
      const text = JSON.stringify([r.old_value, r.new_value])
      expect(text).not.toMatch(/key_hash|key_prefix|phone|h-[0-9a-f]{8}/i)
      expect(text).not.toMatch(/\b0\d{9}\b|\+?233\d{9}/)
    }
    const approve = (await rows(db, "SELECT new_value FROM admin_audit_log WHERE action = 'api_key_approve'"))[0].new_value
    expect(approve).toMatchObject({ key_id: k1, replaced_key_id: old, key_type: "standard", environment: "live" })
  }, 60_000)

  it("approval_context: 30-day top-ups (wallet_topup + momo_claim, completed credits) and orders over the seven tables", async () => {
    const db = await fresh94()
    const u = await mkUser(db, "dealer")
    const v = await mkUser(db, "dealer")
    await db.exec(`
      INSERT INTO transactions(user_id, type, source, amount, status, created_at) VALUES
        ('${u}','credit','wallet_topup',100,'completed',now()),
        ('${u}','credit','momo_claim',25.5,'completed',now() - interval '5 days'),
        ('${u}','credit','wallet_topup',999,'completed',now() - interval '40 days'),
        ('${u}','credit','wallet_topup',888,'pending',now()),
        ('${u}','credit','order_refund',777,'completed',now()),
        ('${u}','debit','wallet_topup',666,'completed',now());
      INSERT INTO orders(user_id, status) VALUES ('${u}','completed');
      INSERT INTO api_orders(user_id, status) VALUES ('${u}','completed'), ('${u}','failed');
      INSERT INTO hubtel_data_orders(user_id, status) VALUES ('${u}','completed');
      INSERT INTO airtime_orders(user_id, status) VALUES ('${u}','completed');
      INSERT INTO hubtel_bill_orders(user_id, status) VALUES ('${u}','completed');
      INSERT INTO results_checker_orders(user_id, status) VALUES ('${u}','completed');
      INSERT INTO afa_orders(user_id, status) VALUES ('${u}','completed');
      INSERT INTO orders(user_id, status, created_at) VALUES ('${u}','completed', now() - interval '31 days');
    `)
    const ctx = await call(db, "api_v2_approval_context", `{${u},${v}}`)
    expect(ctx[u]).toEqual({ topups_30d: 125.5, orders_30d: 8 })
    expect(ctx[v]).toEqual({ topups_30d: 0, orders_30d: 0 })
    expect(await call(db, "api_v2_approval_context", "{}")).toEqual({})
    expect(await call(db, "api_v2_approval_context", null)).toEqual({})
    const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`).join(",")
    await fails(db, `SELECT public.api_v2_approval_context('{${many}}')`, /at most 200/)
  }, 60_000)

  it("privileges: anon and authenticated have no SELECT/INSERT on both tables and no EXECUTE on all functions", async () => {
    const db = await fresh94()
    const fns = [
      "api_v2_approve_key(uuid,uuid)",
      "api_v2_reject_key(uuid,uuid,text)",
      "api_v2_approve_access(uuid,uuid)",
      "api_v2_reject_access(uuid,uuid,text)",
      "api_v2_remove_grant(uuid,uuid,text)",
      "api_v2_approval_context(uuid[])",
      "api_v2_new_request_code()",
    ]
    for (const who of ["anon", "authenticated"]) {
      for (const t of ["api_v2_access_requests", "api_v2_access_grants"]) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect((await rows(db, `SELECT has_table_privilege('${who}', 'public.${t}', '${p}') AS ok`))[0].ok, `${who} ${p} ${t}`).toBe(false)
        }
      }
      for (const f of fns) {
        expect((await rows(db, `SELECT has_function_privilege('${who}', 'public.${f}', 'EXECUTE') AS ok`))[0].ok, `${who} ${f}`).toBe(false)
      }
    }
    for (const f of fns) {
      expect((await rows(db, `SELECT has_function_privilege('service_role', 'public.${f}', 'EXECUTE') AS ok`))[0].ok, `service_role ${f}`).toBe(true)
      expect((await rows(db, `SELECT has_function_privilege('public', 'public.${f}', 'EXECUTE') AS ok`))[0].ok, `PUBLIC ${f}`).toBe(false)
    }
    for (const t of ["api_v2_access_requests", "api_v2_access_grants"]) {
      expect((await rows(db, `SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.${t}'::regclass`))[0].rls).toBe(true)
      expect((await rows(db, `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = '${t}'`))[0].n).toBe(0)
      expect((await rows(db, `SELECT has_table_privilege('service_role', 'public.${t}', 'INSERT') AS ok`))[0].ok).toBe(true)
    }
    // every function is SECURITY DEFINER with the pinned search_path
    const defs = await rows(
      db,
      `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'api_v2_%' AND proname IN ('api_v2_approve_key','api_v2_reject_key','api_v2_approve_access','api_v2_reject_access','api_v2_remove_grant','api_v2_approval_context','api_v2_new_request_code')`,
    )
    expect(defs).toHaveLength(7)
    for (const d of defs) {
      expect(d.prosecdef, d.proname).toBe(true)
      expect((d.proconfig as string[]).some((c) => c.replace(/\s/g, "") === "search_path=public,pg_temp"), d.proname).toBe(true)
    }
  }, 60_000)
})
