// lib/text-to-buy/migration-0181.test.ts
// migrations/0181_text_to_buy_calls.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// Needs 0177 and 0180 applied first (0180 needs the SMS ledger shape, taken from the REAL migrations/0062).
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0181_text_to_buy_calls.sql"
const SELFTEST_FILE = "0181_text_to_buy_calls.selftest.sql"
const migration = () => read(FILE)

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0181:no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0181:run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0181:run string does not end by raising")
  return run
}

describe("0181 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0181[^']*';\s*END\s*\$selftest\$;$/)
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
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`
const FIXTURES = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE TABLE public.admin_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) UNIQUE NOT NULL, value jsonb NOT NULL, description text,
    updated_at timestamptz DEFAULT now(), updated_by uuid REFERENCES auth.users(id));
  CREATE TABLE public.ussd_shop_codes (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.sms_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    owner_type text NOT NULL CHECK (owner_type IN ('platform','shop','sub_agent')),
    owner_id uuid,
    unit_balance int NOT NULL DEFAULT 0 CHECK (unit_balance >= 0),
    status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','suspended')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.sms_unit_transactions (
    id bigserial PRIMARY KEY,
    sms_account_id uuid NOT NULL REFERENCES public.sms_accounts(id) ON DELETE CASCADE,
    delta int NOT NULL, reason text NOT NULL, balance_after int NOT NULL, ref text, campaign_id uuid,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX uq_sms_unit_tx_ref ON public.sms_unit_transactions(ref) WHERE ref IS NOT NULL;
`
const OUTCOMES = [
  "replied_main", "replied_shop", "replied_support", "skipped_duplicate", "skipped_cap",
  "skipped_off", "skipped_invalid", "skipped_blocked", "skipped_stale", "error",
]

async function bootstrap(): Promise<any> {
  const d = new PGliteCtor()
  await d.exec(ROLES)
  await d.exec(FIXTURES)
  await d.exec(read("0062_create_sms_units_functions.sql")) // the real adjust_sms_units
  await d.exec(`
    REVOKE ALL ON FUNCTION adjust_sms_units(UUID, INT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION adjust_sms_units(UUID, INT, TEXT, TEXT, UUID) TO service_role;`) // as migrations/0068
  await d.exec(read("0177_text_to_buy.sql"))
  await d.exec(read("0180_text_to_buy_shop_line.sql"))
  return d
}

describe.skipIf(!PGliteCtor)("0181 in PGlite", () => {
  let db: any
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n)
  const fails = async (sql: string, params: unknown[] = [], re?: RegExp) => {
    const p = expect(db.query(sql, params)).rejects
    await (re ? p.toThrow(re) : p.toThrow())
  }
  const addCall = (line: string, sender: string, outcome: string, createdAt?: string) =>
    db.query("INSERT INTO public.ttb_calls (line, sender, outcome, created_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))", [line, sender, outcome, createdAt ?? null])

  beforeAll(async () => {
    db = await bootstrap()
  }, 60_000)

  it("applies twice without error", async () => {
    await db.exec(migration())
    await db.exec(migration())
    expect(await count("SELECT count(*) AS n FROM pg_class WHERE oid = to_regclass('public.ttb_calls')")).toBe(1)
  })

  it("table: columns, defaults, and the (line, created_at) index", async () => {
    const cols = (
      await db.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ttb_calls' ORDER BY column_name",
      )
    ).rows
    expect(cols).toEqual([
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "line", data_type: "text", is_nullable: "NO" },
      { column_name: "outcome", data_type: "text", is_nullable: "NO" },
      { column_name: "sender", data_type: "text", is_nullable: "NO" },
      { column_name: "shop_id", data_type: "uuid", is_nullable: "YES" },
    ])
    const idx = (await one("SELECT indexdef FROM pg_indexes WHERE tablename = 'ttb_calls' AND indexdef LIKE '%(line, created_at)%'")).indexdef
    expect(idx).toBeTruthy()
  })

  it("CHECKs: line is main or shop, outcome is one of the ten allowed values", async () => {
    for (const o of OUTCOMES) await addCall("main", "0200000401", o)
    await fails("INSERT INTO public.ttb_calls (line, sender, outcome) VALUES ('other', '0200000401', 'error')")
    await fails("INSERT INTO public.ttb_calls (line, sender, outcome) VALUES ('main', '0200000401', 'replied_typo')")
    await fails("INSERT INTO public.ttb_calls (line, sender, outcome) VALUES ('main', NULL, 'error')")
  })

  describe("purge", () => {
    it("deletes calls older than the cut-off and keeps recent ones", async () => {
      await addCall("main", "0200000411", "replied_main", "2001-01-01")
      await addCall("shop", "0200000412", "skipped_cap", "2001-01-01")
      await addCall("main", "0200000413", "replied_main")
      expect(Number((await one("SELECT public.ttb_purge('2002-01-01'::timestamptz) AS n")).n)).toBeGreaterThanOrEqual(2)
      expect(await count("SELECT count(*) AS n FROM public.ttb_calls WHERE sender IN ('0200000411', '0200000412')")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_calls WHERE sender = '0200000413'")).toBe(1)
    })

    it("still does every 0180 purge: messages, conversations, notices, released reserves, shop prefs (open reserves stay)", async () => {
      await db.query("INSERT INTO public.ttb_messages (line, sender, direction, body, created_at) VALUES ('shop', '0200000420', 'in', 'x', '2001-01-01')")
      await db.query("INSERT INTO public.ttb_conversations (line, sender, expires_at) VALUES ('shop', '0200000420', '2001-01-01')")
      await db.query("INSERT INTO public.ttb_notices (kind, sender, shop_id, day, created_at) VALUES ('closed', '0200000420', NULL, '2001-01-01', '2001-01-01')")
      const [rel, open] = [(await one("SELECT gen_random_uuid() AS u")).u, (await one("SELECT gen_random_uuid() AS u")).u]
      const acct = (await one("SELECT gen_random_uuid() AS u")).u
      await db.query(
        "INSERT INTO public.ttb_credit_reserves (message_id, account_id, shop_id, held, released_at, created_at) VALUES ($1, $3, $3, 1, '2001-01-02', '2001-01-01'), ($2, $3, $3, 1, NULL, '2001-01-01')",
        [rel, open, acct],
      )
      const code1 = (await one("INSERT INTO public.ussd_shop_codes DEFAULT VALUES RETURNING id")).id
      await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id, last_used_at) VALUES ('0200000420', $1, '2001-01-01')", [code1])
      expect(Number((await one("SELECT public.ttb_purge('2002-01-01'::timestamptz) AS n")).n)).toBeGreaterThanOrEqual(5)
      expect(await count("SELECT count(*) AS n FROM public.ttb_messages WHERE sender = '0200000420'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_conversations WHERE sender = '0200000420'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_notices WHERE sender = '0200000420'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_shop_prefs WHERE sender = '0200000420'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE message_id = $1", [rel])).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE message_id = $1", [open])).toBe(1)
    })
  })

  describe("privileges", () => {
    it("ttb_calls: RLS on, no policies, nothing for anon/authenticated, service_role SELECT and INSERT only", async () => {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        for (const role of ["anon", "authenticated"]) {
          expect((await one("SELECT has_table_privilege($1, 'public.ttb_calls', $2) AS ok", [role, p])).ok).toBe(false)
        }
        expect((await one("SELECT has_table_privilege('service_role', 'public.ttb_calls', $1) AS ok", [p])).ok).toBe(p === "SELECT" || p === "INSERT")
      }
      expect((await one("SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.ttb_calls'::regclass")).r).toBe(true)
      expect(await count("SELECT count(*) AS n FROM pg_policies WHERE tablename = 'ttb_calls'")).toBe(0)
    })

    it("ttb_purge keeps SECURITY DEFINER, search_path = public, pg_temp and service_role-only execute", async () => {
      const f = "public.ttb_purge(timestamptz)"
      const p = await one("SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure", [f])
      expect(p.prosecdef).toBe(true)
      expect(p.proconfig).toEqual(["search_path=public, pg_temp"])
      for (const role of ["anon", "authenticated"]) {
        expect((await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, f])).ok).toBe(false)
      }
      expect(await count("SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0", [f])).toBe(0)
      expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok).toBe(true)
    })
  })

  it("the self-rolling-back run string reports SELFTEST_OK on a database with 0177 and 0180 applied and leaves nothing behind", async () => {
    const fresh = await bootstrap()
    await expect(fresh.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/SELFTEST_OK 0181/)
    await fresh.exec("ROLLBACK")
    expect((await fresh.query("SELECT to_regclass('public.ttb_calls') AS t")).rows[0].t).toBeNull()
  }, 60_000)
})
