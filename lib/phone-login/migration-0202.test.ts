// migrations/0202_phone_login.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0202-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0202_phone_login.sql"
const SELFTEST_FILE = "0202_phone_login.selftest.sql"
const migration = () => read(FILE)

describe("0202 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("the run string has no COMMIT, no bare END; in the self-test, and ends by raising", () => {
    const run = buildRunString(migration(), read(SELFTEST_FILE))
    const s = code(run)
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0202[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("rejects a run string that could commit", () => {
    expect(() => buildRunString(migration() + "\nCOMMIT;", read(SELFTEST_FILE))).toThrow()
  })

  it("the self-test never inserts or deletes public.users rows", () => {
    const st = code(read(SELFTEST_FILE))
    expect(st).not.toMatch(/INSERT\s+INTO\s+public\.users/i)
    expect(st).not.toMatch(/DELETE\s+FROM\s+public\.users/i)
  })

  it("every function pins search_path; all but the pure ghana_phone_sig are service_role only", () => {
    const m = code(migration())
    const fns = m.match(/CREATE (OR REPLACE )?FUNCTION/g) ?? []
    expect(fns.length).toBe(8)
    expect((m.match(/SET search_path = ''/g) ?? []).length).toBe(8)
    // 7 RPC/trigger functions are service_role only; ghana_phone_sig is the one PUBLIC grant (I5: the users index calls it as the writer)
    expect((m.match(/GRANT EXECUTE ON FUNCTION[^;]*TO service_role;/g) ?? []).length).toBe(7)
    expect(m.match(/GRANT EXECUTE ON FUNCTION[^;]*TO PUBLIC;/g) ?? []).toEqual([
      "GRANT EXECUTE ON FUNCTION public.ghana_phone_sig(text) TO PUBLIC;",
    ])
    expect(m).not.toMatch(/\bTO\s+(anon|authenticated)\b/i)
    expect(m).not.toMatch(/REVOKE[^;]*ghana_phone_sig/i)
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
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`
const U1 = "00000000-0000-4000-8000-000000000001" // shares a phone with U2 (different formats)
const U2 = "00000000-0000-4000-8000-000000000002"
const U3 = "00000000-0000-4000-8000-000000000003" // unique phone
// Prod-shaped stubs. Phone formats are mixed on purpose, as in prod.
const STUBS = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email varchar, encrypted_password varchar, banned_until timestamptz);
  CREATE TABLE public.users (
    id uuid PRIMARY KEY, email varchar NOT NULL, phone_number varchar(20),
    phone_verified boolean NOT NULL DEFAULT false, is_suspended boolean
  );
  CREATE TABLE public.admin_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) UNIQUE NOT NULL, value jsonb NOT NULL);
  INSERT INTO auth.users(id, email, encrypted_password) VALUES
    ('${U1}', 'u1@example.invalid', 'h1'), ('${U2}', 'u2@example.invalid', 'h2'), ('${U3}', 'u3@example.invalid', 'h3');
  INSERT INTO public.users(id, email, phone_number, phone_verified) VALUES
    ('${U1}', 'u1@example.invalid', '0241234567', true),
    ('${U2}', 'u2@example.invalid', '+233 24 123 4567', false),
    ('${U3}', 'u3@example.invalid', '0551112223', true);
`
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  return db
}

describe.skipIf(!PGliteCtor)("0202 in PGlite", () => {
  it("0202 self-test passes: the rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0202/)
    await db.exec("ROLLBACK")
    const r = await db.query("SELECT to_regclass('public.trusted_devices') AS t, to_regprocedure('public.ghana_phone_sig(text)') AS f")
    expect(r.rows[0]).toEqual({ t: null, f: null })
  }, 60_000)

  it("find_account: duplicate sig hides the user, unique sig returns it (the self-test's data branches have data here)", async () => {
    // The self-test skips data checks on empty tables; prove the stubs satisfy them by checking the same conditions here.
    const db = await fresh()
    await db.exec(migration())
    // 1 verified (U1) + 1 unverified (U2): the verified owner wins, an unverified squatter cannot block them
    const dup = await db.query("SELECT * FROM public.phone_login_find_account('241234567')")
    expect(dup.rows).toEqual([
      { match_count: 2, verified_count: 1, user_id: U1, email: "u1@example.invalid", phone_number: "0241234567", phone_verified: true, is_suspended: null },
    ])
    const one = await db.query("SELECT * FROM public.phone_login_find_account('551112223')")
    expect(one.rows).toEqual([
      { match_count: 1, verified_count: 1, user_id: U3, email: "u3@example.invalid", phone_number: "0551112223", phone_verified: true, is_suspended: null },
    ])
    const none = await db.query("SELECT * FROM public.phone_login_find_account('999999999')")
    expect(none.rows).toEqual([
      { match_count: 0, verified_count: 0, user_id: null, email: null, phone_number: null, phone_verified: null, is_suspended: null },
    ])
    // 2 verified on one sig: ambiguous, user columns NULL
    await db.exec(`UPDATE public.users SET phone_verified = true WHERE id = '${U2}'`)
    const two = await db.query("SELECT * FROM public.phone_login_find_account('241234567')")
    expect(two.rows).toEqual([
      { match_count: 2, verified_count: 2, user_id: null, email: null, phone_number: null, phone_verified: null, is_suspended: null },
    ])
    // a single unverified row is returned as is (the app refuses it as ineligible)
    await db.exec(`UPDATE public.users SET phone_verified = false WHERE id = '${U3}'`)
    const unv = await db.query("SELECT * FROM public.phone_login_find_account('551112223')")
    expect(unv.rows).toEqual([
      { match_count: 1, verified_count: 0, user_id: U3, email: "u3@example.invalid", phone_number: "0551112223", phone_verified: false, is_suspended: null },
    ])
  }, 60_000)

  it("applies twice (idempotent) and seeds the two settings without overwriting", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec("UPDATE public.admin_settings SET value = 'true'::jsonb WHERE key = 'phone_login_enabled'")
    await db.exec(migration())
    const r = await db.query("SELECT key, value FROM public.admin_settings WHERE key LIKE 'phone_login_%' ORDER BY key")
    expect(r.rows).toEqual([
      { key: "phone_login_enabled", value: true },
      { key: "phone_login_new_device_code", value: true },
    ])
  }, 60_000)

  it("lockout: 4 false, 5th true, exactly one lockout row; other phones unaffected", async () => {
    const db = await fresh()
    await db.exec(migration())
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) results.push((await db.query("SELECT public.phone_login_record_failure('h-a','i') AS r")).rows[0].r)
    expect(results).toEqual([false, false, false, false, true])
    expect((await db.query("SELECT count(*)::int AS n FROM public.phone_login_events WHERE kind='lockout' AND phone_hash='h-a'")).rows[0].n).toBe(1)
    expect((await db.query("SELECT public.phone_login_is_locked('h-a') AS l")).rows[0].l).toBe(true)
    expect((await db.query("SELECT public.phone_login_is_locked('h-b') AS l")).rows[0].l).toBe(false)
    // failures older than 15 minutes stop counting
    await db.exec("UPDATE public.phone_login_events SET created_at = now() - interval '16 minutes' WHERE kind = 'fail'")
    expect((await db.query("SELECT public.phone_login_is_locked('h-a') AS l")).rows[0].l).toBe(false)
  }, 60_000)

  it("I4: begin_attempt caps in-flight + failed attempts per phone at 5; end_attempt frees a slot; failures still lock", async () => {
    const db = await fresh()
    await db.exec(migration())
    const begin = async (h: string) => (await db.query(`SELECT public.phone_login_begin_attempt('${h}','i') AS r`)).rows[0].r
    const n = async (h: string, kind: string) =>
      (await db.query(`SELECT count(*)::int AS n FROM public.phone_login_events WHERE phone_hash='${h}' AND kind='${kind}'`)).rows[0].n

    // 5 begins with no ends -> the 6th is refused and writes nothing
    const got: boolean[] = []
    for (let i = 0; i < 6; i++) got.push(await begin("h-par"))
    expect(got).toEqual([true, true, true, true, true, false])
    expect(await n("h-par", "attempt")).toBe(5)
    // other phones are unaffected
    expect(await begin("h-other")).toBe(true)

    // end_attempt frees exactly one slot
    await db.query("SELECT public.phone_login_end_attempt('h-par')")
    expect(await n("h-par", "attempt")).toBe(4)
    expect(await begin("h-par")).toBe(true)
    expect(await begin("h-par")).toBe(false)

    // a failure replaces its own attempt row (no double count): 2 begins + 1 failure = 2 rows, not 3
    await begin("h-fail")
    await begin("h-fail")
    await db.query("SELECT public.phone_login_record_failure('h-fail','i')")
    expect(await n("h-fail", "attempt")).toBe(1)
    expect(await n("h-fail", "fail")).toBe(1)

    // fail rows alone still lock: 5 failures -> begin refused
    for (let i = 0; i < 5; i++) await db.query("SELECT public.phone_login_record_failure('h-lock','i')")
    expect(await begin("h-lock")).toBe(false)

    // attempts older than 60 s stop counting; fails older than 15 min stop counting
    await db.exec("UPDATE public.phone_login_events SET created_at = now() - interval '61 seconds' WHERE kind = 'attempt'")
    expect(await begin("h-par")).toBe(true)
    await db.exec("UPDATE public.phone_login_events SET created_at = now() - interval '16 minutes' WHERE kind = 'fail'")
    expect(await begin("h-lock")).toBe(true)

    // end_attempt with nothing to delete is a no-op
    await db.query("SELECT public.phone_login_end_attempt('h-nothing')")
  }, 60_000)

  it("M5/I4: the events CHECK accepts attempt and login_unchallenged and still rejects unknown kinds", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec("INSERT INTO public.phone_login_events(kind) VALUES ('attempt'), ('login_unchallenged')")
    await expect(db.exec("INSERT INTO public.phone_login_events(kind) VALUES ('bogus')")).rejects.toThrow()
  }, 60_000)

  it("M7: a fresh install seeds phone_login_enabled = JSON false and phone_login_new_device_code = JSON true", async () => {
    const db = await fresh()
    await db.exec(migration())
    const r = await db.query("SELECT key, value, jsonb_typeof(value) AS t FROM public.admin_settings WHERE key LIKE 'phone_login_%' ORDER BY key")
    expect(r.rows).toEqual([
      { key: "phone_login_enabled", value: false, t: "boolean" },
      { key: "phone_login_new_device_code", value: true, t: "boolean" },
    ])
  }, 60_000)

  it("each trigger revokes only that user's live devices; password change writes an event", async () => {
    const db = await fresh()
    await db.exec(migration())
    const dev = (u: string, h: string) =>
      db.exec(`INSERT INTO public.trusted_devices(user_id, token_hash, expires_at) VALUES ('${u}', '${h}', now() + interval '1 day')`)
    const revoked = async (h: string) => (await db.query(`SELECT revoked_at IS NOT NULL AS r FROM public.trusted_devices WHERE token_hash='${h}'`)).rows[0].r

    const chal = (id: string, u: string) =>
      db.exec(`INSERT INTO public.phone_login_challenges(id, user_id, browser_secret_hash, otp_phone, last_sent_at, expires_at)
               VALUES ('${id}', '${u}', 'b', '0241234567', now(), now() + interval '10 minutes')`)
    const dead = async (id: string) => (await db.query(`SELECT expires_at <= now() AS d FROM public.phone_login_challenges WHERE id='${id}'`)).rows[0].d

    await dev(U1, "pw"); await dev(U3, "other"); await chal("c-pw", U1); await chal("c-other", U3)
    await db.exec(`UPDATE auth.users SET encrypted_password = 'new' WHERE id = '${U1}'`)
    expect(await revoked("pw")).toBe(true)
    expect(await dead("c-pw")).toBe(true)
    expect(await dead("c-other")).toBe(false)
    expect(await revoked("other")).toBe(false)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.phone_login_events WHERE kind='password_changed' AND user_id='${U1}'`)).rows[0].n).toBe(1)

    await db.exec(`UPDATE auth.users SET encrypted_password = 'new' WHERE id = '${U1}'`) // no change, no event
    expect((await db.query(`SELECT count(*)::int AS n FROM public.phone_login_events WHERE kind='password_changed'`)).rows[0].n).toBe(1)

    await dev(U1, "ban"); await chal("c-ban", U1)
    await db.exec(`UPDATE auth.users SET banned_until = now() + interval '1 hour' WHERE id = '${U1}'`)
    expect(await revoked("ban")).toBe(true)
    expect(await dead("c-ban")).toBe(true)

    await dev(U1, "phone"); await chal("c-phone", U1)
    await db.exec(`UPDATE public.users SET phone_number = '0201112223' WHERE id = '${U1}'`)
    expect(await revoked("phone")).toBe(true)
    expect(await dead("c-phone")).toBe(true)

    await dev(U1, "susp"); await chal("c-susp", U1)
    await db.exec(`UPDATE public.users SET is_suspended = true WHERE id = '${U1}'`)
    expect(await revoked("susp")).toBe(true)
    expect(await dead("c-susp")).toBe(true)
    expect(await dead("c-other")).toBe(false)

    await dev(U1, "unrelated")
    await db.exec(`UPDATE public.users SET phone_verified = false, is_suspended = false WHERE id = '${U1}'`) // un-suspend is not a revoke
    expect(await revoked("unrelated")).toBe(false)
    expect(await revoked("other")).toBe(false)
  }, 60_000)

  it("clients cannot read the tables or execute the RPCs; the index serves the lookup", async () => {
    const db = await fresh()
    await db.exec(migration())
    const q = async (s: string) => (await db.query(s)).rows[0].v
    for (const t of ["phone_login_events", "phone_login_challenges", "trusted_devices"]) {
      expect(await q(`SELECT has_table_privilege('anon','public.${t}','select') OR has_table_privilege('authenticated','public.${t}','select') AS v`)).toBe(false)
      expect(await q(`SELECT relrowsecurity AS v FROM pg_class WHERE oid = 'public.${t}'::regclass`)).toBe(true)
    }
    for (const f of [
      "phone_login_find_account(text)", "phone_login_record_failure(text,text)", "phone_login_is_locked(text)",
      "phone_login_begin_attempt(text,text)", "phone_login_end_attempt(text)",
    ]) {
      expect(await q(`SELECT has_function_privilege('anon','public.${f}','execute') OR has_function_privilege('authenticated','public.${f}','execute') AS v`)).toBe(false)
      expect(await q(`SELECT has_function_privilege('service_role','public.${f}','execute') AS v`)).toBe(true)
    }
    // I5: the expression index calls ghana_phone_sig as the writing role, so every role must be able to execute it
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(await q(`SELECT has_function_privilege('${role}','public.ghana_phone_sig(text)','execute') AS v`)).toBe(true)
    }
    await db.exec("SET enable_seqscan = off")
    const plan = (await db.query("EXPLAIN SELECT id FROM public.users WHERE public.ghana_phone_sig(phone_number) = '241234567'")).rows
    expect(JSON.stringify(plan)).toContain("users_phone_sig_idx")
  }, 60_000)
})
