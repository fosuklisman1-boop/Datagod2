// lib/ai-drafts/migration-0188.test.ts
// migrations/0188_ai_confirm_cards.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0188-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0188_ai_confirm_cards.sql"
const SELFTEST_FILE = "0188_ai_confirm_cards.selftest.sql"
const migration = () => read(FILE)

describe("0188 migration text", () => {
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
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0188[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("locks the new table and function away from client roles", () => {
    const m = code(migration())
    expect(m).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(m).toMatch(/REVOKE ALL ON public\.ai_drafts FROM anon, authenticated/)
    expect(m).toMatch(/REVOKE ALL ON FUNCTION public\.revert_wallet_deduction\(uuid, numeric\) FROM PUBLIC, anon, authenticated/)
    expect(m).toMatch(/GRANT EXECUTE ON FUNCTION public\.revert_wallet_deduction\(uuid, numeric\) TO service_role/)
    expect(m).not.toMatch(/CREATE POLICY/i)
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
const STUBS = `
  CREATE TABLE public.users(id uuid PRIMARY KEY);
  CREATE TABLE public.wallets(user_id uuid PRIMARY KEY, balance numeric, total_spent numeric, updated_at timestamptz);
  CREATE TABLE public.orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.ai_scheduled_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, name text, prompt text,
    context text, schedule_type text, next_run_at timestamptz);
`
const U1 = "00000000-0000-0000-0000-0000000000a1"
const ACTOR_MISSING = "00000000-0000-0000-0000-0000000000ee"
const T1 = "00000000-0000-0000-0000-0000000000d1"
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  return db
}
async function fresh88(): Promise<any> {
  const db = await fresh()
  await db.exec(migration())
  return db
}
async function rows(db: any, sql: string): Promise<any[]> {
  return (await db.query(sql)).rows
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
const seed = `
  INSERT INTO users(id) VALUES ('${U1}');
  INSERT INTO wallets(user_id, balance, total_spent) VALUES ('${U1}', 100, 50);
  INSERT INTO orders DEFAULT VALUES; INSERT INTO orders DEFAULT VALUES;
  INSERT INTO ai_scheduled_tasks(id, name) VALUES ('${T1}', 'seeded');
`

describe.skipIf(!PGliteCtor)("0188 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await db.exec(seed)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0188/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.ai_drafts') AS t")).rows[0].t).toBeNull()
    expect((await rows(db, "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'idempotency_key'"))[0].n).toBe(0)
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await fresh88()
    await db.exec(migration())
  }, 60_000)

  it("ai_drafts accepts a valid draft with defaults and refuses bad status, action, context", async () => {
    const db = await fresh88()
    await db.exec(seed)
    const ins = (ctx: string, act: string, st = "pending") =>
      `INSERT INTO ai_drafts(user_id, context, action, params, display, status, expires_at) VALUES ('${U1}', '${ctx}', '${act}', '{}', '{}', '${st}', now() + interval '10 minutes')`
    await db.exec(ins("dashboard", "wallet_order"))
    const r = (await rows(db, "SELECT status, amount_ghs, outcome FROM ai_drafts"))[0]
    expect(r).toEqual({ status: "pending", amount_ghs: null, outcome: null })
    for (const st of ["pending", "executing", "succeeded", "partial", "failed", "unknown", "expired", "superseded", "cancelled"]) await db.exec(ins("admin", "role_change", st))
    for (const act of ["wallet_order", "wallet_adjustment", "withdrawal_action", "user_suspension", "role_change", "bulk_status_update"]) await db.exec(ins("admin", act))
    await fails(db, ins("dashboard", "wallet_order", "done"), /check/i)
    await fails(db, ins("dashboard", "nuke"), /check/i)
    await fails(db, ins("everywhere", "wallet_order"), /check/i)
    await fails(db, `INSERT INTO ai_drafts(user_id, context, action, params, display, expires_at) VALUES ('${ACTOR_MISSING}', 'admin', 'role_change', '{}', '{}', now())`, /foreign key/i)
  }, 60_000)

  it("clients cannot touch ai_drafts or revert_wallet_deduction; RLS on, no policies", async () => {
    const db = await fresh88()
    for (const who of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await rows(db, `SELECT has_table_privilege('${who}', 'public.ai_drafts', '${priv}') AS p`))[0].p).toBe(false)
      }
      expect((await rows(db, `SELECT has_function_privilege('${who}', 'public.revert_wallet_deduction(uuid,numeric)', 'EXECUTE') AS p`))[0].p).toBe(false)
    }
    expect((await rows(db, `SELECT has_function_privilege('service_role', 'public.revert_wallet_deduction(uuid,numeric)', 'EXECUTE') AS p`))[0].p).toBe(true)
    expect((await rows(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.ai_drafts'::regclass`))[0].r).toBe(true)
    expect(await rows(db, `SELECT 1 FROM pg_policies WHERE tablename = 'ai_drafts'`)).toHaveLength(0)
    await db.exec("SET ROLE authenticated")
    await fails(db, "SELECT * FROM public.ai_drafts", /permission denied/)
    await db.exec("RESET ROLE")
  }, 60_000)

  it("orders.idempotency_key is unique when set and free when NULL", async () => {
    const db = await fresh88()
    await db.exec(seed)
    const ids = (await rows(db, "SELECT id FROM orders")).map((r) => r.id)
    const k = "00000000-0000-0000-0000-0000000000c1"
    await db.exec(`UPDATE orders SET idempotency_key = '${k}' WHERE id = '${ids[0]}'`)
    await fails(db, `UPDATE orders SET idempotency_key = '${k}' WHERE id = '${ids[1]}'`, /duplicate key|unique/i)
    await db.exec("INSERT INTO orders DEFAULT VALUES; INSERT INTO orders DEFAULT VALUES")
    expect((await rows(db, "SELECT count(*)::int AS n FROM orders WHERE idempotency_key IS NULL"))[0].n).toBe(3)
  }, 60_000)

  it("revert_wallet_deduction adds back exactly the amount after interleaved deductions", async () => {
    const db = await fresh88()
    await db.exec(seed)
    await db.exec(`UPDATE wallets SET balance = balance - 20, total_spent = total_spent + 20 WHERE user_id = '${U1}'`)
    await db.exec(`UPDATE wallets SET balance = balance - 10, total_spent = total_spent + 10 WHERE user_id = '${U1}'`)
    expect((await rows(db, `SELECT public.revert_wallet_deduction('${U1}', 20) AS b`))[0].b).toBe("90")
    expect(await rows(db, `SELECT balance::text AS b, total_spent::text AS t FROM wallets`)).toEqual([{ b: "90", t: "60" }])
    // total_spent never goes negative
    expect((await rows(db, `SELECT public.revert_wallet_deduction('${U1}', 500) AS b`))[0].b).toBe("590")
    expect((await rows(db, `SELECT total_spent::text AS t FROM wallets`))[0].t).toBe("0")
  }, 60_000)

  it("revert_wallet_deduction refuses zero, negative, null and a missing wallet", async () => {
    const db = await fresh88()
    await db.exec(seed)
    await fails(db, `SELECT public.revert_wallet_deduction('${U1}', 0)`, /amount/i)
    await fails(db, `SELECT public.revert_wallet_deduction('${U1}', -5)`, /amount/i)
    await fails(db, `SELECT public.revert_wallet_deduction('${U1}', NULL)`, /amount/i)
    await fails(db, `SELECT public.revert_wallet_deduction('00000000-0000-0000-0000-0000000000ff', 5)`, /wallet/i)
    expect((await rows(db, `SELECT balance::text AS b FROM wallets`))[0].b).toBe("100")
  }, 60_000)

  it("ai_scheduled_tasks gets standing_order, approved_draft_id (FK) and consecutive_skips default 0", async () => {
    const db = await fresh88()
    await db.exec(`INSERT INTO ai_scheduled_tasks(name) VALUES ('t')`)
    const r = (await rows(db, "SELECT standing_order, approved_draft_id, consecutive_skips FROM ai_scheduled_tasks"))[0]
    expect(r).toEqual({ standing_order: null, approved_draft_id: null, consecutive_skips: 0 })
    await fails(db, `UPDATE ai_scheduled_tasks SET approved_draft_id = gen_random_uuid()`, /foreign key/i)
  }, 60_000)

  it("authenticated and anon cannot set the server-only standing-order columns (insert and update)", async () => {
    const db = await fresh88()
    await db.exec(`INSERT INTO ai_scheduled_tasks(id, name) VALUES ('${T1}', 't')`)
    for (const who of ["authenticated", "anon"]) {
      await db.exec(`SET ROLE ${who}`)
      await fails(db, `INSERT INTO ai_scheduled_tasks(name, standing_order) VALUES ('x', '{"a":1}')`, /STANDING_ORDER_SERVER_ONLY/)
      await fails(db, `INSERT INTO ai_scheduled_tasks(name, approved_draft_id) VALUES ('x', gen_random_uuid())`, /STANDING_ORDER_SERVER_ONLY/)
      await fails(db, `INSERT INTO ai_scheduled_tasks(name, consecutive_skips) VALUES ('x', 3)`, /STANDING_ORDER_SERVER_ONLY/)
      await fails(db, `UPDATE ai_scheduled_tasks SET standing_order = '{"a":1}' WHERE id = '${T1}'`, /STANDING_ORDER_SERVER_ONLY/)
      await fails(db, `UPDATE ai_scheduled_tasks SET approved_draft_id = gen_random_uuid() WHERE id = '${T1}'`, /STANDING_ORDER_SERVER_ONLY/)
      await fails(db, `UPDATE ai_scheduled_tasks SET consecutive_skips = 9 WHERE id = '${T1}'`, /STANDING_ORDER_SERVER_ONLY/)
      await db.exec("RESET ROLE")
    }
    expect(await rows(db, `SELECT 1 FROM ai_scheduled_tasks WHERE standing_order IS NOT NULL OR consecutive_skips <> 0`)).toHaveLength(0)
  }, 60_000)

  it("service_role can set the standing-order columns", async () => {
    const db = await fresh88()
    await db.exec(`INSERT INTO ai_scheduled_tasks(id, name) VALUES ('${T1}', 't')`)
    await db.exec("SET ROLE service_role")
    await db.exec(`UPDATE ai_scheduled_tasks SET standing_order = '{"a":1}', consecutive_skips = 2 WHERE id = '${T1}'`)
    await db.exec(`INSERT INTO ai_scheduled_tasks(name, standing_order) VALUES ('y', '{"b":2}')`)
    await db.exec("RESET ROLE")
    expect(await rows(db, `SELECT 1 FROM ai_scheduled_tasks WHERE standing_order IS NOT NULL`)).toHaveLength(2)
    // the postgres owner is unaffected too
    await db.exec(`UPDATE ai_scheduled_tasks SET consecutive_skips = 0 WHERE id = '${T1}'`)
  }, 60_000)

  it("authenticated can still update other columns, and inserts with default server-only values", async () => {
    const db = await fresh88()
    await db.exec(`INSERT INTO ai_scheduled_tasks(id, name) VALUES ('${T1}', 't')`)
    await db.exec("SET ROLE authenticated")
    await db.exec(`UPDATE ai_scheduled_tasks SET name = 'renamed' WHERE id = '${T1}'`)
    await db.exec(`INSERT INTO ai_scheduled_tasks(name) VALUES ('plain')`)
    await db.exec("RESET ROLE")
    expect(await rows(db, `SELECT name FROM ai_scheduled_tasks ORDER BY name`)).toEqual([{ name: "plain" }, { name: "renamed" }])
  }, 60_000)

  it("the guard function is SECURITY INVOKER and closed to client roles", async () => {
    const db = await fresh88()
    expect((await rows(db, `SELECT prosecdef AS d FROM pg_proc WHERE proname = 'ai_scheduled_tasks_guard_standing_order'`))[0].d).toBe(false)
    for (const who of ["anon", "authenticated"]) {
      expect((await rows(db, `SELECT has_function_privilege('${who}', 'public.ai_scheduled_tasks_guard_standing_order()', 'EXECUTE') AS p`))[0].p).toBe(false)
    }
  }, 60_000)

  const D1 = "00000000-0000-0000-0000-0000000000f1"
  const draftFor = (id: string, user: string) =>
    `INSERT INTO ai_drafts(id, user_id, context, action, params, display, expires_at) VALUES ('${id}', '${user}', 'dashboard', 'wallet_order', '{}', '{}', now() + interval '10 minutes')`

  for (const who of ["owner", "service_role", "authenticated"]) {
    it(`delete_user_cascades_drafts (${who}): removing a user removes their drafts and nulls the task link without tripping the guard`, async () => {
      const db = await fresh88()
      await db.exec(seed)
      await db.exec(draftFor(D1, U1))
      await db.exec(`UPDATE ai_scheduled_tasks SET approved_draft_id = '${D1}', standing_order = '{"a":1}' WHERE id = '${T1}'`)
      if (who !== "owner") await db.exec(`SET ROLE ${who}`)
      await db.exec(`DELETE FROM users WHERE id = '${U1}'`)
      await db.exec("RESET ROLE")
      expect(await rows(db, "SELECT 1 FROM ai_drafts")).toHaveLength(0)
      expect(await rows(db, `SELECT approved_draft_id FROM ai_scheduled_tasks WHERE id = '${T1}'`)).toEqual([{ approved_draft_id: null }])
    }, 60_000)
  }

  it("delete_draft_nulls_task_link", async () => {
    const db = await fresh88()
    await db.exec(seed)
    await db.exec(draftFor(D1, U1))
    await db.exec(`UPDATE ai_scheduled_tasks SET approved_draft_id = '${D1}' WHERE id = '${T1}'`)
    await db.exec(`DELETE FROM ai_drafts WHERE id = '${D1}'`)
    expect(await rows(db, `SELECT approved_draft_id, standing_order FROM ai_scheduled_tasks WHERE id = '${T1}'`)).toEqual([
      { approved_draft_id: null, standing_order: null },
    ])
  }, 60_000)

  it("the foreign keys carry the intended delete actions", async () => {
    const db = await fresh88()
    const act = async (t: string, col: string) =>
      (await rows(db, `SELECT c.confdeltype AS a FROM pg_constraint c JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = ANY(c.conkey) WHERE c.contype = 'f' AND c.conrelid = 'public.${t}'::regclass AND at.attname = '${col}'`))[0].a
    expect(await act("ai_drafts", "user_id")).toBe("c")
    expect(await act("ai_scheduled_tasks", "approved_draft_id")).toBe("n")
  }, 60_000)
})
