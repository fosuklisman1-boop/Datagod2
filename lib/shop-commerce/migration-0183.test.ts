// lib/shop-commerce/migration-0183.test.ts
// migrations/0183_shop_customer_prefs.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// Prerequisite tables are minimal stubs (like the 0180 test); only the columns 0183 reads are faked.
import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0183_shop_customer_prefs.sql"
const SELFTEST_FILE = "0183_shop_customer_prefs.selftest.sql"
const migration = () => read(FILE)

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0183:no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0183:run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0183:run string does not end by raising")
  return run
}

describe("0183 migration text", () => {
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
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0183[^']*';\s*END\s*\$selftest\$;$/)
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
// minimal stubs of the prerequisite tables (shapes of 0180 ttb_shop_prefs and 20260730 wa_shop_customer_prefs)
const FIXTURES = `
  CREATE TABLE public.user_shops (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.ussd_shop_codes (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.ttb_shop_prefs (
    sender text PRIMARY KEY,
    shop_code_id uuid NOT NULL REFERENCES public.ussd_shop_codes(id) ON DELETE CASCADE,
    last_used_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.wa_shop_customer_prefs (
    phone text PRIMARY KEY,
    shop_code_id uuid NOT NULL REFERENCES public.ussd_shop_codes(id) ON DELETE CASCADE,
    last_used_at timestamptz NOT NULL DEFAULT now());
`

async function bootstrap(): Promise<any> {
  const d = new PGliteCtor()
  await d.exec(ROLES)
  await d.exec(FIXTURES)
  return d
}

describe.skipIf(!PGliteCtor)("0183 in PGlite", () => {
  let db: any
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n)
  const newCode = async () => (await one("INSERT INTO public.ussd_shop_codes DEFAULT VALUES RETURNING id")).id as string
  const rows = async () => (await db.query("SELECT phone, shop_code_id, last_channel FROM public.shop_customer_prefs ORDER BY phone")).rows

  beforeEach(async () => {
    db = await bootstrap()
  }, 60_000)

  it("creates the table with RLS on and zero policies, and nothing for anon/authenticated", async () => {
    await db.exec(migration())
    expect((await one("SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.shop_customer_prefs'::regclass")).r).toBe(true)
    expect(await count("SELECT count(*) AS n FROM pg_policies WHERE tablename = 'shop_customer_prefs'")).toBe(0)
    for (const role of ["anon", "authenticated"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await one("SELECT has_table_privilege($1, 'public.shop_customer_prefs', $2) AS ok", [role, p])).ok).toBe(false)
      }
    }
    expect((await one("SELECT has_table_privilege('service_role', 'public.shop_customer_prefs', 'SELECT') AS ok")).ok).toBe(true)
  })

  it("rejects phone '+233241234567' and channel 'web'", async () => {
    await db.exec(migration())
    const c = await newCode()
    await expect(db.query("INSERT INTO public.shop_customer_prefs (phone, shop_code_id, last_channel) VALUES ('+233241234567', $1, 'sms')", [c])).rejects.toThrow()
    await expect(db.query("INSERT INTO public.shop_customer_prefs (phone, shop_code_id, last_channel) VALUES ('0241234567', $1, 'web')", [c])).rejects.toThrow()
    await db.query("INSERT INTO public.shop_customer_prefs (phone, shop_code_id, last_channel) VALUES ('0241234567', $1, 'ussd_uzo')", [c])
    expect(await count("SELECT count(*) AS n FROM public.shop_customer_prefs")).toBe(1)
  })

  it("backfills newest-wins", async () => {
    const [a, b] = [await newCode(), await newCode()]
    await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id, last_used_at) VALUES ('0241234567', $1, '2026-01-01')", [a])
    await db.query("INSERT INTO public.wa_shop_customer_prefs (phone, shop_code_id, last_used_at) VALUES ('233241234567', $1, '2026-02-01')", [b])
    await db.exec(migration())
    const r = await rows()
    expect(r).toEqual([{ phone: "0241234567", shop_code_id: b, last_channel: "whatsapp" }])
  })

  it("backfills sms when the ttb row is newer", async () => {
    const [a, b] = [await newCode(), await newCode()]
    await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id, last_used_at) VALUES ('0241234567', $1, '2026-03-01')", [a])
    await db.query("INSERT INTO public.wa_shop_customer_prefs (phone, shop_code_id, last_used_at) VALUES ('233241234567', $1, '2026-02-01')", [b])
    await db.exec(migration())
    expect(await rows()).toEqual([{ phone: "0241234567", shop_code_id: a, last_channel: "sms" }])
  })

  it("normalises '+233' and '233' wa phones and skips malformed ones", async () => {
    const c = await newCode()
    await db.query("INSERT INTO public.wa_shop_customer_prefs (phone, shop_code_id) VALUES ('233241111111', $1), ('+233242222222', $1), ('23324', $1), ('0243333333', $1)", [c])
    await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id) VALUES ('12345', $1)", [c])
    await db.exec(migration())
    expect((await rows()).map((r: any) => r.phone)).toEqual(["0241111111", "0242222222", "0243333333"])
  })

  it("is re-runnable: twice gives no error and no duplicates", async () => {
    const c = await newCode()
    await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id) VALUES ('0241234567', $1)", [c])
    await db.exec(migration())
    await db.exec(migration())
    expect(await count("SELECT count(*) AS n FROM public.shop_customer_prefs")).toBe(1)
  })

  it("cascades on code delete", async () => {
    const c = await newCode()
    await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id) VALUES ('0241234567', $1)", [c])
    await db.exec(migration())
    expect(await count("SELECT count(*) AS n FROM public.shop_customer_prefs")).toBe(1)
    await db.query("DELETE FROM public.ussd_shop_codes WHERE id = $1", [c])
    expect(await count("SELECT count(*) AS n FROM public.shop_customer_prefs")).toBe(0)
  })

  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/SELFTEST_OK 0183/)
    await db.exec("ROLLBACK")
    expect((await one("SELECT to_regclass('public.shop_customer_prefs') AS t")).t).toBeNull()
  }, 60_000)
})
