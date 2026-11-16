// lib/text-to-buy/migration-0180.test.ts
// migrations/0180_text_to_buy_shop_line.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// The SMS ledger shape comes from the REAL migrations/0062 (adjust_sms_units); only the tables it needs are faked.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0180_text_to_buy_shop_line.sql"
const SELFTEST_FILE = "0180_text_to_buy_shop_line.selftest.sql"
const migration = () => read(FILE)

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0180:no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0180:run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0180:run string does not end by raising")
  return run
}

describe("0180 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("moves credits only through adjust_sms_units (no direct balance update)", () => {
    const c = code(migration())
    expect(c).not.toMatch(/UPDATE\s+(public\.)?sms_accounts[^;]*unit_balance/i)
    expect(c).not.toMatch(/INSERT\s+INTO\s+(public\.)?sms_unit_transactions/i)
    expect(c).toMatch(/public\.adjust_sms_units/)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0180[^']*';\s*END\s*\$selftest\$;$/)
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
  -- shapes of migrations/0061 + 0065 (status widened to inactive) + the ref unique index
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
const TABLES = ["ttb_shop_prefs", "ttb_notices", "ttb_credit_reserves"]
const FUNCS = [
  "public.ttb_notice_once(text,text,uuid,date)",
  "public.ttb_reserve_credits(uuid,uuid,uuid,integer)",
  "public.ttb_draw_reserve(uuid,integer)",
  "public.ttb_undraw_reserve(uuid,integer)",
  "public.ttb_release_reserve(uuid)",
  "public.ttb_debit_reply(uuid,integer,text)",
  "public.ttb_refund_reply(uuid,integer,text)",
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
  return d
}

describe.skipIf(!PGliteCtor)("0180 in PGlite", () => {
  let db: any
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n)
  const fails = async (sql: string, params: unknown[] = [], re?: RegExp) => {
    const p = expect(db.query(sql, params)).rejects
    await (re ? p.toThrow(re) : p.toThrow())
  }
  /** a fresh sms account; returns its id */
  const account = async (balance: number, status = "active") => {
    const u = (await one("INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id")).id
    return (
      await one(
        "INSERT INTO public.sms_accounts (user_id, owner_type, unit_balance, status) VALUES ($1, 'shop', $2, $3) RETURNING id",
        [u, balance, status],
      )
    ).id as string
  }
  const balance = async (acct: string) => Number((await one("SELECT unit_balance AS n FROM public.sms_accounts WHERE id = $1", [acct])).n)
  const ledger = async (acct: string) =>
    (await db.query("SELECT delta, reason, ref, balance_after FROM public.sms_unit_transactions WHERE sms_account_id = $1 ORDER BY id", [acct])).rows
  const uid = async () => (await one("SELECT gen_random_uuid() AS u")).u as string
  const reserve = async (acct: string, msg: string, shop: string, credits: number) =>
    (await one("SELECT public.ttb_reserve_credits($1::uuid, $2::uuid, $3::uuid, $4) AS ok", [acct, msg, shop, credits])).ok
  const draw = async (msg: string, credits: number) => (await one("SELECT public.ttb_draw_reserve($1::uuid, $2) AS ok", [msg, credits])).ok
  const undraw = async (msg: string, credits: number) => (await one("SELECT public.ttb_undraw_reserve($1::uuid, $2) AS ok", [msg, credits])).ok
  const usedOf = async (msg: string) => Number((await one("SELECT used FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).used)
  const release = async (msg: string) => Number((await one("SELECT public.ttb_release_reserve($1::uuid) AS n", [msg])).n)

  beforeAll(async () => {
    db = await bootstrap()
  }, 60_000)

  it("applies twice without error", async () => {
    await db.exec(migration())
    await db.exec(migration())
    for (const t of TABLES) expect(await count("SELECT count(*) AS n FROM pg_class WHERE oid = to_regclass($1)", ["public." + t])).toBe(1)
  })

  it("adds nullable shop_id / credits columns to orders and messages", async () => {
    const cols = (
      await db.query(
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND ((table_name = 'ttb_orders' AND column_name = 'shop_id')
             OR (table_name = 'ttb_messages' AND column_name IN ('shop_id', 'credits'))) ORDER BY table_name, column_name`,
      )
    ).rows
    expect(cols).toEqual([
      { table_name: "ttb_messages", column_name: "credits", data_type: "integer", is_nullable: "YES" },
      { table_name: "ttb_messages", column_name: "shop_id", data_type: "uuid", is_nullable: "YES" },
      { table_name: "ttb_orders", column_name: "shop_id", data_type: "uuid", is_nullable: "YES" },
    ])
  })

  it("ttb_shop_prefs: one row per sender, cascades when the shop code is deleted", async () => {
    const code1 = (await one("INSERT INTO public.ussd_shop_codes DEFAULT VALUES RETURNING id")).id
    await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id) VALUES ('0200000201', $1)", [code1])
    await fails("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id) VALUES ('0200000201', $1)", [code1])
    await fails("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id) VALUES ('0200000202', gen_random_uuid())") // FK
    expect((await one("SELECT last_used_at IS NOT NULL AS ok FROM public.ttb_shop_prefs WHERE sender = '0200000201'")).ok).toBe(true)
    await db.query("DELETE FROM public.ussd_shop_codes WHERE id = $1", [code1])
    expect(await count("SELECT count(*) AS n FROM public.ttb_shop_prefs WHERE sender = '0200000201'")).toBe(0)
  })

  it("heartbeat CHECK now accepts quiet_alert_shop and still refuses typos", async () => {
    for (const line of ["main", "shop", "purge", "quiet_alert", "quiet_alert_shop"]) {
      await db.query("INSERT INTO public.ttb_heartbeat (line, last_seen_at) VALUES ($1, now()) ON CONFLICT (line) DO NOTHING", [line])
    }
    await fails("INSERT INTO public.ttb_heartbeat (line, last_seen_at) VALUES ('typo', now())")
    expect(await count("SELECT count(*) AS n FROM public.ttb_heartbeat WHERE line = 'quiet_alert_shop'")).toBe(1)
  })

  describe("ttb_notice_once", () => {
    const notice = async (kind: string, sender: string, shop: string | null, day: string) =>
      (await one("SELECT public.ttb_notice_once($1, $2, $3::uuid, $4::date) AS ok", [kind, sender, shop, day])).ok

    it("is true once then false, per kind, sender, shop and day (a null shop is one slot, not many)", async () => {
      const shopA = await uid()
      const shopB = await uid()
      expect(await notice("closed", "0200000210", shopA, "2090-01-01")).toBe(true)
      expect(await notice("closed", "0200000210", shopA, "2090-01-01")).toBe(false)
      expect(await notice("closed", "0200000210", shopB, "2090-01-01")).toBe(true) // other shop
      expect(await notice("closed", "0200000211", shopA, "2090-01-01")).toBe(true) // other sender
      expect(await notice("other", "0200000210", shopA, "2090-01-01")).toBe(true) // other kind
      expect(await notice("closed", "0200000210", shopA, "2090-01-02")).toBe(true) // next day
      expect(await notice("unknown", "0200000210", null, "2090-01-01")).toBe(true)
      expect(await notice("unknown", "0200000210", null, "2090-01-01")).toBe(false) // NULL shop must not bypass the throttle
    })
  })

  describe("reserve lifecycle", () => {
    it("reserves once: debits through the ledger with reason text_to_buy and ref ttb:<message>; a repeat debits nothing more", async () => {
      const acct = await account(10)
      const msg = await uid()
      const shop = await uid()
      expect(await reserve(acct, msg, shop, 3)).toBe(true)
      expect(await balance(acct)).toBe(7)
      expect(await reserve(acct, msg, shop, 3)).toBe(false)
      expect(await balance(acct)).toBe(7)
      expect(await ledger(acct)).toEqual([{ delta: -3, reason: "text_to_buy", ref: `ttb:${msg}`, balance_after: 7 }])
      expect(await one("SELECT held, used, released_at, shop_id, account_id FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).toEqual({
        held: 3,
        used: 0,
        released_at: null,
        shop_id: shop,
        account_id: acct,
      })
    })

    it("an inactive, suspended or missing account raises and moves nothing; no reserve row survives", async () => {
      const msg = await uid()
      const shop = await uid()
      const inactive = await account(10, "inactive")
      await fails("SELECT public.ttb_reserve_credits($1::uuid, $2::uuid, $3::uuid, 2)", [inactive, msg, shop], /NOT_ACTIVATED/)
      const suspended = await account(10, "suspended")
      await fails("SELECT public.ttb_reserve_credits($1::uuid, $2::uuid, $3::uuid, 2)", [suspended, msg, shop], /SUSPENDED/)
      await fails("SELECT public.ttb_reserve_credits(gen_random_uuid(), $1::uuid, $2::uuid, 2)", [msg, shop], /NOT_ACTIVATED/)
      expect(await balance(inactive)).toBe(10)
      expect(await balance(suspended)).toBe(10)
      expect(await ledger(inactive)).toEqual([])
      expect(await ledger(suspended)).toEqual([])
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).toBe(0)
    })

    it("too few credits raises INSUFFICIENT_CREDITS, leaves the balance and no reserve row; a bad amount raises INVALID_AMOUNT", async () => {
      const acct = await account(1)
      const msg = await uid()
      const shop = await uid()
      await fails("SELECT public.ttb_reserve_credits($1::uuid, $2::uuid, $3::uuid, 2)", [acct, msg, shop], /INSUFFICIENT_CREDITS/)
      await fails("SELECT public.ttb_reserve_credits($1::uuid, $2::uuid, $3::uuid, 0)", [acct, msg, shop], /INVALID_AMOUNT/)
      await fails("SELECT public.ttb_reserve_credits($1::uuid, $2::uuid, $3::uuid, -2)", [acct, msg, shop], /INVALID_AMOUNT/)
      expect(await balance(acct)).toBe(1)
      expect(await ledger(acct)).toEqual([])
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).toBe(0)
    })

    it("two reserves racing on a balance of 3 for 2 each: exactly one succeeds, the balance is never negative", async () => {
      const acct = await account(3)
      const shop = await uid()
      const [m1, m2] = [await uid(), await uid()]
      const results = await Promise.allSettled([reserve(acct, m1, shop, 2), reserve(acct, m2, shop, 2)])
      expect(results.filter((r) => r.status === "fulfilled" && (r as any).value === true)).toHaveLength(1)
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
      expect(rejected).toHaveLength(1)
      expect(String(rejected[0].reason)).toMatch(/INSUFFICIENT_CREDITS/)
      expect(await balance(acct)).toBe(1)
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE account_id = $1", [acct])).toBe(1)
      expect((await ledger(acct)).length).toBe(1)
    })

    it("draw adds to used only while open and within held; beyond held, after release, or unknown returns false", async () => {
      const acct = await account(10)
      const msg = await uid()
      await reserve(acct, msg, await uid(), 3)
      expect(await draw(msg, 1)).toBe(true)
      expect(await draw(msg, 2)).toBe(true) // used = 3 = held
      expect(await draw(msg, 1)).toBe(false) // beyond held
      expect((await one("SELECT used FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).used).toBe(3)
      const m2 = await uid()
      await reserve(acct, m2, await uid(), 3)
      expect(await draw(m2, 4)).toBe(false) // single draw beyond held
      expect(await draw(m2, 1)).toBe(true)
      await release(m2)
      expect(await draw(m2, 1)).toBe(false) // released
      expect(await draw(await uid(), 1)).toBe(false) // unknown message
      expect(await draw(m2, 0)).toBe(false)
      expect(await draw(m2, -1)).toBe(false)
    })

    it("undraw restores used after a draw; more than used returns false and changes nothing; after release returns false; unknown message false", async () => {
      const acct = await account(10)
      const msg = await uid()
      await reserve(acct, msg, await uid(), 3)
      expect(await draw(msg, 2)).toBe(true)
      expect(await usedOf(msg)).toBe(2)
      expect(await undraw(msg, 1)).toBe(true)
      expect(await usedOf(msg)).toBe(1)
      expect(await undraw(msg, 2)).toBe(false) // more than used
      expect(await usedOf(msg)).toBe(1)
      expect(await undraw(msg, 0)).toBe(false)
      expect(await undraw(msg, -1)).toBe(false)
      expect(await usedOf(msg)).toBe(1)
      expect(await draw(msg, 2)).toBe(true) // the undrawn credit is usable again, up to held
      expect(await draw(msg, 1)).toBe(false)
      expect(await release(msg)).toBe(0)
      expect(await undraw(msg, 1)).toBe(false) // released: nothing to give back
      expect(await usedOf(msg)).toBe(3)
      expect(await undraw(await uid(), 1)).toBe(false) // unknown message
      expect(await balance(acct)).toBe(7) // an undraw never moves money
    })

    it("release refunds held-used once with reason text_to_buy_refund and ref ttb:<message>:release; the second call refunds 0", async () => {
      const acct = await account(10)
      const msg = await uid()
      await reserve(acct, msg, await uid(), 3)
      await draw(msg, 1)
      expect(await release(msg)).toBe(2)
      expect(await balance(acct)).toBe(9) // 10 - 3 + 2
      expect(await release(msg)).toBe(0)
      expect(await balance(acct)).toBe(9)
      expect(await ledger(acct)).toEqual([
        { delta: -3, reason: "text_to_buy", ref: `ttb:${msg}`, balance_after: 7 },
        { delta: 2, reason: "text_to_buy_refund", ref: `ttb:${msg}:release`, balance_after: 9 },
      ])
      expect((await one("SELECT released_at IS NOT NULL AS r FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).r).toBe(true)
    })

    it("release after full use refunds 0, writes no ledger row, and still closes the reserve", async () => {
      const acct = await account(10)
      const msg = await uid()
      await reserve(acct, msg, await uid(), 2)
      await draw(msg, 2)
      expect(await release(msg)).toBe(0)
      expect((await ledger(acct)).length).toBe(1)
      expect((await one("SELECT released_at IS NOT NULL AS r FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).r).toBe(true)
      expect(await release(await uid())).toBe(0) // unknown message
    })

    it("release is one transaction: if the refund cannot be made, the reserve is NOT marked released (retryable)", async () => {
      const acct = await account(10)
      const msg = await uid()
      await reserve(acct, msg, await uid(), 3)
      await db.query("DELETE FROM public.sms_accounts WHERE id = $1", [acct]) // the refund target vanishes
      await fails("SELECT public.ttb_release_reserve($1::uuid)", [msg], /REFUND_FAILED/)
      expect((await one("SELECT released_at FROM public.ttb_credit_reserves WHERE message_id = $1", [msg])).released_at).toBeNull()
    })

    it("a refund is allowed on a suspended account (no status gate on money coming back)", async () => {
      const acct = await account(10)
      const msg = await uid()
      await reserve(acct, msg, await uid(), 3)
      await db.query("UPDATE public.sms_accounts SET status = 'suspended' WHERE id = $1", [acct])
      expect(await release(msg)).toBe(3)
      expect(await balance(acct)).toBe(10)
    })
  })

  describe("single-reply debit and refund", () => {
    const debit = async (acct: string, credits: number, ref: string) =>
      (await one("SELECT public.ttb_debit_reply($1::uuid, $2, $3) AS ok", [acct, credits, ref])).ok
    const refund = async (acct: string, credits: number, ref: string) =>
      (await one("SELECT public.ttb_refund_reply($1::uuid, $2, $3) AS ok", [acct, credits, ref])).ok

    it("debit uses the same status gate, writes reason text_to_buy, and is idempotent per ref", async () => {
      const acct = await account(5)
      expect(await debit(acct, 1, "ttb:reply:a")).toBe(true)
      expect(await debit(acct, 1, "ttb:reply:a")).toBe(false) // same ref: no second debit
      expect(await balance(acct)).toBe(4)
      expect(await ledger(acct)).toEqual([{ delta: -1, reason: "text_to_buy", ref: "ttb:reply:a", balance_after: 4 }])
      const inactive = await account(5, "inactive")
      await fails("SELECT public.ttb_debit_reply($1::uuid, 1, 'ttb:reply:b')", [inactive], /NOT_ACTIVATED/)
      const suspended = await account(5, "suspended")
      await fails("SELECT public.ttb_debit_reply($1::uuid, 1, 'ttb:reply:c')", [suspended], /SUSPENDED/)
      const empty = await account(0)
      await fails("SELECT public.ttb_debit_reply($1::uuid, 1, 'ttb:reply:d')", [empty], /INSUFFICIENT_CREDITS/)
      await fails("SELECT public.ttb_debit_reply($1::uuid, 0, 'ttb:reply:e')", [acct], /INVALID_AMOUNT/)
      await fails("SELECT public.ttb_debit_reply($1::uuid, 1, NULL)", [acct], /INVALID_REF/)
      for (const a of [inactive, suspended, empty]) expect(await ledger(a)).toEqual([])
    })

    it("refund returns the debited credits exactly once per ref (reason text_to_buy_refund), only for a real earlier debit", async () => {
      const acct = await account(5)
      await debit(acct, 2, "ttb:reply:r")
      expect(await balance(acct)).toBe(3)
      expect(await refund(acct, 2, "ttb:reply:r")).toBe(true)
      expect(await balance(acct)).toBe(5)
      expect(await refund(acct, 2, "ttb:reply:r")).toBe(false) // twice by one ref refunds once
      expect(await balance(acct)).toBe(5)
      expect((await ledger(acct)).map((r: any) => [r.delta, r.reason])).toEqual([
        [-2, "text_to_buy"],
        [2, "text_to_buy_refund"],
      ])
      expect(await refund(acct, 1, "ttb:reply:never-debited")).toBe(false) // cannot mint credits
      const other = await account(5)
      await debit(other, 1, "ttb:reply:o")
      expect(await refund(acct, 1, "ttb:reply:o")).toBe(false) // another account's debit
      expect(await balance(acct)).toBe(5)
    })

    it("a reserve ref (ttb:<uuid>) or a release ref can never be debited or refunded through the reply functions", async () => {
      const acct = await account(10)
      const msg = await uid()
      expect(await reserve(acct, msg, await uid(), 3)).toBe(true)
      const before = await ledger(acct)
      const bal = await balance(acct)
      await fails("SELECT public.ttb_debit_reply($1::uuid, 1, $2)", [acct, `ttb:${msg}`], /INVALID_REF/)
      await fails("SELECT public.ttb_debit_reply($1::uuid, 1, $2)", [acct, `ttb:${msg}:release`], /INVALID_REF/)
      await fails("SELECT public.ttb_debit_reply($1::uuid, 1, 'some-other-ref')", [acct], /INVALID_REF/)
      expect(await refund(acct, 3, `ttb:${msg}`)).toBe(false) // the reserve's own debit must stay refundable only through its release
      expect(await ledger(acct)).toEqual(before)
      expect(await balance(acct)).toBe(bal)
      expect(await release(msg)).toBeGreaterThanOrEqual(0)
    })

    it("a refund never exceeds what the ref debited", async () => {
      const acct = await account(5)
      await debit(acct, 1, "ttb:reply:cap")
      expect(await refund(acct, 4, "ttb:reply:cap")).toBe(true)
      expect(await balance(acct)).toBe(5)
    })
  })

  describe("purge", () => {
    it("deletes old notices and released reserves, keeps open and recent ones (an unreleased reserve still owes a refund)", async () => {
      const acct = await account(100)
      const [released, open, recent] = [await uid(), await uid(), await uid()]
      for (const m of [released, open, recent]) await reserve(acct, m, await uid(), 2)
      await release(released)
      await db.query("UPDATE public.ttb_credit_reserves SET created_at = '2001-01-01', released_at = '2001-01-02' WHERE message_id = $1", [released])
      await db.query("UPDATE public.ttb_credit_reserves SET created_at = '2001-01-01' WHERE message_id = $1", [open])
      await release(recent)
      await db.query("INSERT INTO public.ttb_notices (kind, sender, shop_id, day, created_at) VALUES ('closed', '0200000290', NULL, '2001-01-01', '2001-01-01')")
      await db.query("INSERT INTO public.ttb_notices (kind, sender, shop_id, day) VALUES ('closed', '0200000291', NULL, current_date)")
      const n = Number((await one("SELECT public.ttb_purge('2002-01-01'::timestamptz) AS n")).n)
      expect(n).toBeGreaterThanOrEqual(2)
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE message_id = $1", [released])).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE message_id = $1", [open])).toBe(1)
      expect(await count("SELECT count(*) AS n FROM public.ttb_credit_reserves WHERE message_id = $1", [recent])).toBe(1)
      expect(await count("SELECT count(*) AS n FROM public.ttb_notices WHERE sender = '0200000290'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_notices WHERE sender = '0200000291'")).toBe(1)
    })

    it("deletes shop prefs not used since the cut-off and keeps recent ones", async () => {
      const [oldCode, newCode] = [(await one("INSERT INTO public.ussd_shop_codes DEFAULT VALUES RETURNING id")).id, (await one("INSERT INTO public.ussd_shop_codes DEFAULT VALUES RETURNING id")).id]
      await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id, last_used_at) VALUES ('0200000293', $1, '2001-01-01')", [oldCode])
      await db.query("INSERT INTO public.ttb_shop_prefs (sender, shop_code_id) VALUES ('0200000294', $1)", [newCode])
      expect(Number((await one("SELECT public.ttb_purge('2002-01-01'::timestamptz) AS n")).n)).toBeGreaterThanOrEqual(1)
      expect(await count("SELECT count(*) AS n FROM public.ttb_shop_prefs WHERE sender = '0200000293'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_shop_prefs WHERE sender = '0200000294'")).toBe(1)
    })

    it("still deletes old messages and expired conversations as in 0177", async () => {
      await db.query("INSERT INTO public.ttb_messages (line, sender, direction, body, created_at) VALUES ('shop', '0200000292', 'in', 'x', '2001-01-01')")
      await db.query("INSERT INTO public.ttb_conversations (line, sender, expires_at) VALUES ('shop', '0200000292', '2001-01-01')")
      const before = await count("SELECT count(*) AS n FROM public.ttb_messages WHERE sender = '0200000292'")
      expect(before).toBe(1)
      expect(Number((await one("SELECT public.ttb_purge('2002-01-01'::timestamptz) AS n")).n)).toBeGreaterThanOrEqual(2)
      expect(await count("SELECT count(*) AS n FROM public.ttb_messages WHERE sender = '0200000292'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_conversations WHERE sender = '0200000292'")).toBe(0)
    })
  })

  describe("privileges", () => {
    it("every new function (and the replaced ttb_purge) pins search_path to public, pg_temp", async () => {
      const r = await db.query(
        "SELECT proname, proconfig FROM pg_proc WHERE proname IN ('ttb_notice_once','ttb_reserve_credits','ttb_draw_reserve','ttb_undraw_reserve','ttb_release_reserve','ttb_debit_reply','ttb_refund_reply','ttb_purge')",
      )
      expect(r.rows).toHaveLength(8)
      for (const f of r.rows) expect(f.proconfig).toEqual(["search_path=public, pg_temp"])
    })

    it("new tables: RLS on, no policies, nothing for anon/authenticated, no TRUNCATE or DELETE for service_role", async () => {
      for (const t of TABLES) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          for (const role of ["anon", "authenticated"]) {
            expect((await one("SELECT has_table_privilege($1, $2, $3) AS ok", [role, "public." + t, p])).ok).toBe(false)
          }
        }
        expect((await one("SELECT relrowsecurity AS r FROM pg_class WHERE oid = $1::regclass", ["public." + t])).r).toBe(true)
        expect(await count("SELECT count(*) AS n FROM pg_policies WHERE tablename = $1", [t])).toBe(0)
        expect((await one("SELECT has_table_privilege('service_role', $1, 'SELECT') AS ok", ["public." + t])).ok).toBe(true)
        expect((await one("SELECT has_table_privilege('service_role', $1, 'TRUNCATE') AS ok", ["public." + t])).ok).toBe(false)
        expect((await one("SELECT has_table_privilege('service_role', $1, 'DELETE') AS ok", ["public." + t])).ok).toBe(false)
      }
      // reserves and notices change only through the functions
      for (const t of ["ttb_credit_reserves", "ttb_notices"]) {
        for (const p of ["INSERT", "UPDATE"]) {
          expect((await one("SELECT has_table_privilege('service_role', $1, $2) AS ok", ["public." + t, p])).ok).toBe(false)
        }
      }
    })

    it("anon, authenticated and PUBLIC cannot execute any new function; service_role can; all are SECURITY DEFINER", async () => {
      for (const f of FUNCS) {
        for (const role of ["anon", "authenticated"]) {
          expect((await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, f])).ok).toBe(false)
        }
        expect(await count("SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0", [f])).toBe(0)
        expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok).toBe(true)
        expect((await one("SELECT p.prosecdef AS d FROM pg_proc p WHERE p.oid = $1::regprocedure", [f])).d).toBe(true)
      }
    })

    it("ttb_purge keeps service_role-only execute after being replaced", async () => {
      const f = "public.ttb_purge(timestamptz)"
      for (const role of ["anon", "authenticated"]) {
        expect((await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, f])).ok).toBe(false)
      }
      expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok).toBe(true)
    })
  })

  it("the self-rolling-back run string reports SELFTEST_OK on a database with 0177 applied and leaves nothing behind", async () => {
    const fresh = await bootstrap()
    await expect(fresh.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/SELFTEST_OK 0180/)
    await fresh.exec("ROLLBACK")
    expect((await fresh.query("SELECT to_regclass('public.ttb_credit_reserves') AS t")).rows[0].t).toBeNull()
    expect((await fresh.query("SELECT count(*)::int AS n FROM public.sms_accounts")).rows[0].n).toBe(0)
    expect((await fresh.query("SELECT count(*)::int AS n FROM public.sms_unit_transactions")).rows[0].n).toBe(0)
  }, 60_000)
})
