// lib/ussd-hubtel/wallet-migration.test.ts
// migrations/0159_hubtel_wallet_payments.sql and its self-test. The static checks follow
// lib/standard-bundles/bot-special-migration.test.ts and always run. The behaviour block runs the real SQL in PGlite.
//
// PGlite is not a dependency of this repo (reference-pglite-sql-tests): the block is SKIPPED, visibly, where the
// package cannot be resolved. To run it, unpack @electric-sql/pglite@0.2.17 into the gitignored node_modules/.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

// CRLF -> LF: the repo checks migrations out with CRLF, and `--.*$` would not strip a comment ending in "\r".
const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")

const FILE = "0159_hubtel_wallet_payments.sql"
const SELFTEST_FILE = "0159_hubtel_wallet_payments.selftest.sql"
const migration = () => read(FILE)
const SIG = "public.pay_hubtel_order_from_wallet(text, uuid, text, uuid, numeric, text, text)"
const ORDER_TABLES = ["ussd_orders", "airtime_orders", "results_checker_orders", "results_check_requests"]
const SOURCES = ["ussd_data_purchase", "airtime_purchase", "ussd_results_checker", "results_check_request"]

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")

/** The function body between `AS $fn$` and the closing `$fn$;`. */
function rpcBody(): string {
  const m = migration().match(/CREATE OR REPLACE FUNCTION public\.pay_hubtel_order_from_wallet\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/)
  if (!m) throw new Error("0159: pay_hubtel_order_from_wallet body not found")
  return code(m[1])
}

/**
 * House run string: the migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on.
 * The 0130 incident lesson: this string is what goes to production, so the code that builds it refuses a bad one.
 */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map(l => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0159: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex(l => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0159: run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0159: run string does not end by raising")
  return run
}
const runString = () => buildRunString(migration(), read(SELFTEST_FILE))

describe("0159 migration text", () => {
  it("is one transaction with lock and statement timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("is SECURITY DEFINER with a pinned search_path, executable by service_role only", () => {
    const m = migration()
    const head = m.match(/CREATE OR REPLACE FUNCTION public\.pay_hubtel_order_from_wallet\(([\s\S]*?)AS \$fn\$/)
    expect(head).not.toBeNull()
    expect(head![1]).toMatch(/p_session\s+text,\s*p_user\s+uuid,\s*p_table\s+text,\s*p_order\s+uuid,\s*p_amount\s+numeric,\s*p_source\s+text,\s*p_description\s+text/)
    expect(head![1]).toMatch(/RETURNS jsonb/)
    expect(head![1]).toMatch(/SECURITY DEFINER/)
    expect(head![1]).toMatch(/SET search_path = public/)
    expect(m).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated;`)
    expect(m).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role;`)
    expect(code(m).match(/GRANT EXECUTE ON FUNCTION public\.pay_hubtel_order_from_wallet/g)).toHaveLength(1)
  })

  it("locks the table down: RLS on, no policies, nothing for PUBLIC, anon or authenticated", () => {
    const c = code(migration())
    expect(c).toMatch(/ALTER TABLE public\.hubtel_wallet_payments ENABLE ROW LEVEL SECURITY;/)
    expect(c).toMatch(/REVOKE ALL ON TABLE public\.hubtel_wallet_payments FROM PUBLIC, anon, authenticated;/)
    expect(c).not.toMatch(/CREATE POLICY/i)
  })

  it("locks the wallet, then looks for a replay, then validates, then debits, then writes", () => {
    const b = rpcBody()
    const at = [
      b.search(/FROM public\.wallets w WHERE w\.user_id = p_user FOR UPDATE/),
      b.search(/WHERE p\.session_id = p_session/),
      b.search(/p_table NOT IN/),
      b.search(/SELECT \* INTO d FROM public\.deduct_wallet\(p_user, p_amount\)/),
      b.search(/INSERT INTO public\.transactions/),
      b.search(/INSERT INTO public\.hubtel_wallet_payments/),
    ]
    for (const i of at) expect(i).toBeGreaterThan(-1)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(b.match(/deduct_wallet\(/g)).toHaveLength(1)
    expect(b.match(/INSERT INTO/g)).toHaveLength(2)
  })

  it("never touches an order row: the only UPDATE is the wallet lock, and no dynamic SQL could hide one", () => {
    const b = rpcBody()
    expect(b.match(/\bUPDATE\b/gi)).toEqual(["UPDATE"])
    expect(b).toMatch(/FOR UPDATE/)
    expect(b).not.toMatch(/\bEXECUTE\b/i)
    expect(b).not.toMatch(/\bDELETE\b/i)
    for (const t of ORDER_TABLES) expect(b).not.toMatch(new RegExp(`(UPDATE|INTO|FROM)\\s+(public\\.)?${t}\\b`, "i"))
  })

  it("never re-raises Postgres's own error", () => {
    const b = rpcBody()
    expect(b).not.toMatch(/\bRAISE\s*;/)
    expect(b).toMatch(/WHEN unique_violation THEN/)
    expect(b).toMatch(/WHEN integrity_constraint_violation THEN/)
    // Fixed strings only: no %-placeholder could carry a phone or a row value into an error.
    for (const m of b.matchAll(/RAISE EXCEPTION '([^']*)'/g)) expect(m[1]).toMatch(/^(BAD_INPUT|INSUFFICIENT_FUNDS|ALREADY_CARTED)$/)
  })

  it("states the pre-checks: the source check, the unique key, deduct_wallet and every order table's id type", () => {
    const m = migration()
    const header = m.slice(0, m.search(/^BEGIN;/m))
    expect(header).toMatch(/PRE-CHECKS/)
    expect(header).toContain("transactions_source_check")
    expect(header).toContain("unique_transaction_reference")
    expect(header).toMatch(/proname = 'deduct_wallet' AND prosecdef/)
    expect(header).toMatch(/data_type/)
    for (const t of [...ORDER_TABLES, ...SOURCES]) expect(header).toContain(t)
  })
})

describe("0159 run string (migration + self-test)", () => {
  it("has no COMMIT and no bare END; statement, and ends with the always-raising DO block", () => {
    const s = code(runString())
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("the builder refuses a second COMMIT, a bare END; and a self-test that does not raise last", () => {
    const m = migration()
    const st = read(SELFTEST_FILE)
    expect(() => buildRunString(m.replace(/^BEGIN;/m, "BEGIN;\nCOMMIT;"), st)).toThrow(/could commit/)
    expect(() => buildRunString(m, st.replace(/^DO \$selftest\$;?/m, "$&\n--\nCOMMIT;"))).toThrow(/could commit/)
    expect(() => buildRunString(m.replace(/^BEGIN;/m, "BEGIN;\nEND;"), st)).toThrow(/could commit/)
    expect(() => buildRunString(m, st.replace(/RAISE EXCEPTION 'SELFTEST_OK[^']*';/, ""))).toThrow(/does not end by raising/)
  })

  it("self-test covers every required scenario", () => {
    const st = read(SELFTEST_FILE)
    for (const label of ["catalog", "order_id_types", "grants", "deny_anon", "deny_authenticated", "happy", "replay", "replay_other_amount",
                         "session_other_order", "session_other_user", "other_session_same_order", "already_carted", "short_wallet",
                         "no_wallet", "bad_table", "bad_source", "amount_zero", "amount_negative", "amount_three_dp",
                         "every_table_and_source", "debit_already_recorded"]) {
      expect(st).toContain(label)
    }
  })
})

// ───────────────────────────────────────── Behaviour, in PGlite ─────────────────────────────────────────

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
  -- Supabase's defaults (and 0060 for tables), so the REVOKEs are really tested. service_role is left out on purpose,
  -- so its table access has to come from the migration's own GRANT.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
`
const FIXTURES = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE TABLE public.users (id uuid PRIMARY KEY, role text);
  CREATE TABLE public.wallets (user_id uuid PRIMARY KEY, balance numeric NOT NULL, total_spent numeric NOT NULL DEFAULT 0, updated_at timestamptz);
  CREATE TABLE public.transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, type varchar(50) NOT NULL, source varchar(100),
    amount numeric(15,2) NOT NULL, balance_before numeric(15,2), balance_after numeric(15,2), description text,
    reference_id varchar(100), status varchar(50) DEFAULT 'completed', created_at timestamp DEFAULT now(),
    CONSTRAINT unique_transaction_reference UNIQUE (user_id, reference_id, type));
  CREATE TABLE public.ussd_orders (id uuid PRIMARY KEY);
  CREATE TABLE public.airtime_orders (id uuid PRIMARY KEY);
  CREATE TABLE public.results_checker_orders (id uuid PRIMARY KEY);
  CREATE TABLE public.results_check_requests (id uuid PRIMARY KEY);
  -- The self-test's admin: the largest wallet, so a behaviour test's wallet is never picked.
  INSERT INTO auth.users VALUES ('5f0c1a9e-0159-4159-8159-000000000001');
  INSERT INTO public.users VALUES ('5f0c1a9e-0159-4159-8159-000000000001', 'admin');
  INSERT INTO public.wallets (user_id, balance) VALUES ('5f0c1a9e-0159-4159-8159-000000000001', 500);
`

const PHONE = "233249990162"
const DESCRIPTION = `Wallet payment: 1GB to ${PHONE}`
let seq = 0
const uuid = (prefix: string) => `5f0c1a9e-${prefix}-4159-8159-${String(++seq).padStart(12, "0")}`
const newSession = () => `sess-${++seq}`

interface CallArgs { session?: unknown; user?: unknown; table?: unknown; order?: unknown; amount?: unknown; source?: unknown; description?: unknown }

describe.skipIf(!PGliteCtor)("0159 in PGlite", () => {
  let db: any
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n)
  const call = async (a: CallArgs) => {
    const res = await db.query(
      "SELECT public.pay_hubtel_order_from_wallet($1::text, $2::uuid, $3::text, $4::uuid, $5::numeric, $6::text, $7::text) AS r",
      ["session" in a ? a.session : newSession(), a.user, "table" in a ? a.table : "ussd_orders", "order" in a ? a.order : uuid("0a0a"),
       "amount" in a ? a.amount : "5.00", "source" in a ? a.source : "ussd_data_purchase", "description" in a ? a.description : DESCRIPTION],
    )
    return res.rows[0].r
  }
  const newUser = async (balance: string | null = "20.00", spent = "1.00") => {
    const user = uuid("0b0b")
    if (balance !== null) await db.query("INSERT INTO public.wallets (user_id, balance, total_spent) VALUES ($1, $2, $3)", [user, balance, spent])
    return user
  }
  /** Everything a call could change for this user. Compared whole, so "writes nothing" means nothing. */
  const ledger = async (user: string) => JSON.stringify([
    await one("SELECT balance::numeric(15,2) AS b, total_spent::numeric(15,2) AS s FROM public.wallets WHERE user_id = $1", [user]),
    await count("SELECT count(*) AS n FROM public.transactions WHERE user_id = $1", [user]),
    await count("SELECT count(*) AS n FROM public.hubtel_wallet_payments WHERE user_id = $1", [user]),
  ])
  const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected the call to fail") }, (e: any) => e)
  const expectClean = (err: any, message: string) => {
    expect(err.message).toBe(message)
    expect(JSON.stringify({ m: err.message, d: err.detail, h: err.hint })).not.toContain(PHONE)
  }

  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(FIXTURES)
    await db.exec(read("0089_deduct_wallet_positivity_guard.sql"))
    await db.exec(read("0106_hubtel_ussd.sql"))
  }, 60_000)

  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const before = await one("SELECT balance, total_spent FROM public.wallets WHERE user_id = '5f0c1a9e-0159-4159-8159-000000000001'")
    try {
      await expect(db.exec(runString())).rejects.toThrow(/SELFTEST_OK 0159/)
    } finally {
      await db.exec("ROLLBACK") // also on a failure, so it cannot hide the behaviour tests below
    }
    expect(await count("SELECT count(*) AS n FROM pg_proc WHERE proname = 'pay_hubtel_order_from_wallet'")).toBe(0)
    expect((await one("SELECT to_regclass('public.hubtel_wallet_payments') AS t")).t).toBeNull()
    expect(await count("SELECT count(*) AS n FROM public.transactions")).toBe(0)
    expect(await count("SELECT count(*) AS n FROM public.hubtel_transactions")).toBe(0)
    expect(await one("SELECT balance, total_spent FROM public.wallets WHERE user_id = '5f0c1a9e-0159-4159-8159-000000000001'")).toEqual(before)
  })

  describe("after apply", () => {
    beforeAll(async () => {
      await db.exec(migration())
      await db.exec(migration()) // idempotent
    })

    it("the table has the agreed shape", async () => {
      const cols = (await db.query(`SELECT column_name AS c, data_type AS t, is_nullable AS n, numeric_precision AS p, numeric_scale AS s
                                      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hubtel_wallet_payments'`)).rows
      const by = Object.fromEntries(cols.map((r: any) => [r.c, r]))
      expect(Object.keys(by).sort()).toEqual(["amount", "created_at", "id", "order_id", "order_table", "review_reason", "session_id", "state", "transaction_reference", "updated_at", "user_id"])
      for (const c of ["id", "order_id", "user_id"]) expect(by[c].t).toBe("uuid")
      for (const c of ["id", "session_id", "order_table", "order_id", "user_id", "amount", "state", "created_at", "updated_at"]) expect(by[c].n).toBe("NO")
      for (const c of ["review_reason", "transaction_reference"]) expect(by[c].n).toBe("YES")
      expect([by.amount.p, by.amount.s]).toEqual([12, 2])

      const idx = (await db.query("SELECT indexdef AS d FROM pg_indexes WHERE tablename = 'hubtel_wallet_payments'")).rows.map((r: any) => r.d)
      expect(idx.some((d: string) => /UNIQUE/.test(d) && /\(session_id\)/.test(d))).toBe(true)
      expect(idx.some((d: string) => /UNIQUE/.test(d) && /\(order_table, order_id\)/.test(d))).toBe(true)
      expect(idx.some((d: string) => /\(created_at\) WHERE \(state = 'debited'::text\)/.test(d))).toBe(true)
    })

    it("the table refuses a bad state and a non-positive amount", async () => {
      const insert = (amount: string, state: string) => db.query(
        `INSERT INTO public.hubtel_wallet_payments (session_id, order_table, order_id, user_id, amount, state) VALUES ($1, 'ussd_orders', $2, $3, $4, $5)`,
        [newSession(), uuid("0c0c"), uuid("0c0c"), amount, state])
      await expect(insert("1.00", "paid")).rejects.toThrow(/check constraint/)
      await expect(insert("0", "debited")).rejects.toThrow(/check constraint/)
      for (const s of ["debited", "fulfilled", "needs_review"]) await expect(insert("1.00", s)).resolves.toBeTruthy()
      await db.exec("DELETE FROM public.hubtel_wallet_payments")
    })

    it("a paying call debits once and writes one history row and one debited payment row", async () => {
      const user = await newUser("20.00", "1.00")
      const order = uuid("0a0a")
      const session = newSession()
      const r = await call({ session, user, order, table: "airtime_orders", amount: "5.25", source: "airtime_purchase" })
      expect(r.replay).toBe(false)
      expect(Number(r.new_balance)).toBe(14.75)

      const w = await one("SELECT balance, total_spent FROM public.wallets WHERE user_id = $1", [user])
      expect([Number(w.balance), Number(w.total_spent)]).toEqual([14.75, 6.25])

      const tx = (await db.query("SELECT * FROM public.transactions WHERE user_id = $1", [user])).rows
      expect(tx).toHaveLength(1)
      expect(tx[0]).toMatchObject({ type: "debit", source: "airtime_purchase", reference_id: order, description: DESCRIPTION, status: "completed" })
      expect([tx[0].amount, tx[0].balance_before, tx[0].balance_after].map(Number)).toEqual([5.25, 20, 14.75])

      const pay = (await db.query("SELECT * FROM public.hubtel_wallet_payments WHERE user_id = $1", [user])).rows
      expect(pay).toHaveLength(1)
      expect(pay[0]).toMatchObject({ id: r.payment_id, session_id: session, order_table: "airtime_orders", order_id: order, state: "debited",
                                     review_reason: null, transaction_reference: order })
      expect(Number(pay[0].amount)).toBe(5.25)
    })

    it("the exact balance pays, and leaves zero", async () => {
      const user = await newUser("5.00")
      expect(Number((await call({ user, amount: "5.00" })).new_balance)).toBe(0)
    })

    it("prosrc names none of the four order tables in an UPDATE", async () => {
      const { src } = await one("SELECT prosrc AS src FROM pg_proc WHERE proname = 'pay_hubtel_order_from_wallet'")
      expect(src.length).toBeGreaterThan(100)
      for (const t of ORDER_TABLES) expect(src).not.toMatch(new RegExp(`UPDATE\\s+(public\\.)?${t}\\b`, "i"))
    })

    it("a repeat with the same session is a replay: same id, no second debit, whatever the amount", async () => {
      const user = await newUser("20.00")
      const order = uuid("0a0a")
      const session = newSession()
      const first = await call({ session, user, order })
      const after = await ledger(user)
      for (const amount of ["5.00", "7.00", "0", "-1", "1.999", null]) {
        const again = await call({ session, user, order, amount })
        expect(again.replay).toBe(true)
        expect(again.payment_id).toBe(first.payment_id)
        expect(Number(again.new_balance)).toBe(15)
      }
      expect(await ledger(user)).toBe(after)
      const row = await one("SELECT amount FROM public.hubtel_wallet_payments WHERE id = $1", [first.payment_id])
      expect(Number(row.amount)).toBe(5)
    })

    it("the same session on a different order is refused, not a replay", async () => {
      const user = await newUser()
      const session = newSession()
      const order = uuid("0a0a")
      await call({ session, user, order })
      const after = await ledger(user)
      expectClean(await failure(call({ session, user, order: uuid("0a0a") })), "BAD_INPUT")
      expectClean(await failure(call({ session, user, order, table: "airtime_orders" })), "BAD_INPUT")
      expectClean(await failure(call({ session, user, order: null })), "BAD_INPUT")
      expect(await ledger(user)).toBe(after)
    })

    it("the same session and order from another user is refused and shows nothing of the first", async () => {
      const user = await newUser()
      const other = await newUser()
      const session = newSession()
      const order = uuid("0a0a")
      await call({ session, user, order })
      const before = [await ledger(user), await ledger(other)]
      expectClean(await failure(call({ session, user: other, order })), "BAD_INPUT")
      expect([await ledger(user), await ledger(other)]).toEqual(before)
    })

    it("a different session on the same order is refused and writes nothing, for either user", async () => {
      const user = await newUser()
      const other = await newUser()
      const order = uuid("0a0a")
      await call({ user, order })
      const before = [await ledger(user), await ledger(other)]
      expectClean(await failure(call({ user, order })), "BAD_INPUT")
      expectClean(await failure(call({ user: other, order })), "BAD_INPUT")
      expect([await ledger(user), await ledger(other)]).toEqual(before)
    })

    it("the same order id under another table collides on the history key, which has no table in it: refused", async () => {
      const user = await newUser()
      const order = uuid("0a0a")
      await call({ user, order, table: "ussd_orders" })
      const after = await ledger(user)
      expectClean(await failure(call({ user, order, table: "airtime_orders" })), "BAD_INPUT")
      expect(await ledger(user)).toBe(after)
    })

    it("a session with a hubtel_transactions row raises ALREADY_CARTED and writes nothing", async () => {
      const user = await newUser()
      const session = newSession()
      await db.query(`INSERT INTO public.hubtel_transactions (session_id, order_table, order_id, expected_amount) VALUES ($1, 'ussd_orders', $2, 5)`, [session, uuid("0a0a")])
      const before = await ledger(user)
      expectClean(await failure(call({ session, user })), "ALREADY_CARTED")
      expect(await ledger(user)).toBe(before)
    })

    it("a balance short by one pesewa raises INSUFFICIENT_FUNDS and writes nothing", async () => {
      const user = await newUser("4.99")
      const before = await ledger(user)
      expectClean(await failure(call({ user, amount: "5.00" })), "INSUFFICIENT_FUNDS")
      expect(await ledger(user)).toBe(before)
    })

    it("a user with no wallet raises INSUFFICIENT_FUNDS and writes nothing", async () => {
      const user = await newUser(null)
      expectClean(await failure(call({ user })), "INSUFFICIENT_FUNDS")
      expect(await count("SELECT count(*) AS n FROM public.transactions WHERE user_id = $1", [user])).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.hubtel_wallet_payments WHERE user_id = $1", [user])).toBe(0)
    })

    const REFUSALS: [string, CallArgs][] = [
      ["no session", { session: null }],
      ["a blank session", { session: "   " }],
      ["no user", { user: null }],
      ["no order", { order: null }],
      ["no table", { table: null }],
      ["ussd_shop_orders, which is not on the list", { table: "ussd_shop_orders" }],
      ["ussd_afa_orders, which is not on the list", { table: "ussd_afa_orders" }],
      ["a table in the wrong case", { table: "USSD_ORDERS" }],
      ["a table with a schema", { table: "public.ussd_orders" }],
      ["a zero amount", { amount: "0" }],
      ["a negative amount", { amount: "-5.00" }],
      ["an amount with 3 decimals", { amount: "1.005" }],
      ["no amount", { amount: null }],
      ["a NaN amount", { amount: "NaN" }],
      ["an amount of a million", { amount: "1000000" }],
      ["no source", { source: null }],
      ["a source not on the list", { source: "data_purchase" }],
      ["a source in the wrong case", { source: "AIRTIME_PURCHASE" }],
      ["no description", { description: null }],
      ["a blank description", { description: "  " }],
    ]
    it.each(REFUSALS)("BAD_INPUT and nothing written: %s", async (_label, args) => {
      const user = await newUser()
      const before = await ledger(user)
      expectClean(await failure(call({ user, ...args })), "BAD_INPUT")
      expect(await ledger(user)).toBe(before)
    })

    it.each(ORDER_TABLES.flatMap(t => SOURCES.map(s => [t, s])))("pays on %s with source %s", async (table, source) => {
      const user = await newUser()
      const r = await call({ user, table, source, amount: "1.00" })
      expect(r.replay).toBe(false)
      expect(await count("SELECT count(*) AS n FROM public.transactions WHERE user_id = $1 AND source = $2", [user, source])).toBe(1)
    })

    it("a debit already recorded for the order collides on the history key: refused, no money moved, no data leaked", async () => {
      const user = await newUser()
      const order = uuid("0a0a")
      await db.query(`INSERT INTO public.transactions (user_id, type, source, amount, description, reference_id) VALUES ($1, 'debit', 'ussd_data_purchase', 5, $2, $3)`, [user, DESCRIPTION, order])
      const before = await ledger(user)
      const err = await failure(call({ user, order }))
      expectClean(err, "BAD_INPUT")
      expect(JSON.stringify({ d: err.detail })).not.toContain(user)
      expect(JSON.stringify({ d: err.detail })).not.toContain(order)
      expect(await ledger(user)).toBe(before)
    })

    it("any other constraint refusing the row rolls the debit back and reports a fixed error, not the failing row", async () => {
      const user = await newUser()
      const before = await ledger(user)
      await db.exec("ALTER TABLE public.transactions ADD CONSTRAINT selftest_source_check CHECK (source <> 'airtime_purchase') NOT VALID")
      try {
        const err = await failure(call({ user, source: "airtime_purchase" }))
        expectClean(err, "BAD_INPUT")
        expect(JSON.stringify({ d: err.detail })).not.toContain(user)
      } finally {
        await db.exec("ALTER TABLE public.transactions DROP CONSTRAINT selftest_source_check")
      }
      expect(await ledger(user)).toBe(before)
    })

    // PGlite has one connection, so two real sessions cannot race. This puts the "other session's" row in at the only
    // gap there is, after the session and order lookups and before the debit: hubtel_transactions becomes a view whose
    // function inserts the winner when the RPC runs its ALREADY_CARTED check. The RPC cannot tell this from a race.
    const raceWith = async (winner: { session: string; order: string; user: string }, run: () => Promise<void>) => {
      await db.exec(`
        BEGIN;
        ALTER TABLE public.hubtel_transactions RENAME TO hubtel_transactions_real;
        CREATE FUNCTION public.selftest_inject_winner() RETURNS TABLE (session_id text) LANGUAGE plpgsql AS $inject$
        BEGIN
          INSERT INTO public.hubtel_wallet_payments (session_id, order_table, order_id, user_id, amount)
          VALUES ('${winner.session}', 'ussd_orders', '${winner.order}', '${winner.user}', 5) ON CONFLICT DO NOTHING;
          RETURN;
        END $inject$;
        CREATE VIEW public.hubtel_transactions AS SELECT * FROM public.selftest_inject_winner();
      `)
      try {
        await run()
      } finally {
        await db.exec("ROLLBACK")
      }
    }

    it("race, same session and order: the loser's debit rolls back and it returns the winner as a replay", async () => {
      const user = await newUser("20.00")
      const session = newSession()
      const order = uuid("0a0a")
      await raceWith({ session, order, user }, async () => {
        const r = await call({ session, user, order })
        const winner = await one("SELECT id FROM public.hubtel_wallet_payments WHERE session_id = $1", [session])
        expect(r).toEqual({ payment_id: winner.id, replay: true, new_balance: 20 })
        expect(await count("SELECT count(*) AS n FROM public.transactions WHERE user_id = $1", [user])).toBe(0)
        expect(await count("SELECT count(*) AS n FROM public.hubtel_wallet_payments WHERE session_id = $1", [session])).toBe(1)
      })
    })

    it("race, same session on a different order: a fixed error, no raw unique_violation", async () => {
      const user = await newUser()
      const session = newSession()
      await raceWith({ session, order: uuid("0a0a"), user }, async () => {
        const err = await failure(call({ session, user, order: uuid("0a0a") }))
        expectClean(err, "BAD_INPUT")
        expect(err.code).not.toBe("23505")
      })
    })

    it("race, another session on the same order: a fixed error, no raw unique_violation", async () => {
      const user = await newUser()
      const order = uuid("0a0a")
      await raceWith({ session: newSession(), order, user }, async () => {
        const err = await failure(call({ user, order }))
        expectClean(err, "BAD_INPUT")
        expect(err.code).not.toBe("23505")
      })
    })

    it.each([["anon"], ["authenticated"]])("%s cannot execute the function or touch the table", async role => {
      const user = await newUser()
      const before = await ledger(user)
      await db.exec(`SET ROLE ${role}`)
      try {
        await expect(call({ user })).rejects.toThrow(/permission denied for function/)
        await expect(db.query("SELECT * FROM public.hubtel_wallet_payments")).rejects.toThrow(/permission denied for table/)
        await expect(db.query("UPDATE public.hubtel_wallet_payments SET state = 'fulfilled'")).rejects.toThrow(/permission denied for table/)
      } finally {
        await db.exec("RESET ROLE")
      }
      expect(await ledger(user)).toBe(before)
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const { ok } = await one("SELECT has_table_privilege($1, 'public.hubtel_wallet_payments', $2) AS ok", [role, p])
        expect(ok).toBe(false)
      }
    })

    it("PUBLIC cannot execute it, RLS is on and there are no policies", async () => {
      expect(await count(`SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a
                           WHERE p.proname = 'pay_hubtel_order_from_wallet' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`)).toBe(0)
      const { rls } = await one("SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.hubtel_wallet_payments'::regclass")
      expect(rls).toBe(true)
      expect(await count("SELECT count(*) AS n FROM pg_policies WHERE tablename = 'hubtel_wallet_payments'")).toBe(0)
    })

    it("service_role can execute it, read a payment and move its state", async () => {
      const user = await newUser()
      await db.exec("SET ROLE service_role")
      try {
        const r = await call({ user })
        expect(r.replay).toBe(false)
        const row = await one("SELECT state FROM public.hubtel_wallet_payments WHERE id = $1", [r.payment_id])
        expect(row.state).toBe("debited")
        await db.query("UPDATE public.hubtel_wallet_payments SET state = 'fulfilled', updated_at = now() WHERE id = $1", [r.payment_id])
      } finally {
        await db.exec("RESET ROLE")
      }
    })
  })
})
