// lib/momo-claim/migration.test.ts
// migrations/0160_momo_send_and_claim.sql (tables part) and its self-test. Follows lib/ussd-hubtel/wallet-migration.test.ts.
// Task 5 adds the money functions to the same migration file; the checks here are written so they keep holding then.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

// CRLF -> LF: the repo checks migrations out with CRLF, and `--.*$` would not strip a comment ending in "\r".
const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")

const FILE = "0160_momo_send_and_claim.sql"
const SELFTEST_FILE = "0160_momo_send_and_claim.selftest.sql"
const migration = () => read(FILE)
const TABLES = ["momo_transactions", "wallet_topup_sessions", "momo_claim_attempts", "momo_reconciliation_runs"]

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map(l => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0160: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex(l => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0160: run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0160: run string does not end by raising")
  return run
}
const runString = () => buildRunString(migration(), read(SELFTEST_FILE))

describe("0160 migration text", () => {
  it("is one transaction with lock and statement timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("creates wallet_topup_sessions before momo_transactions, which references it", () => {
    const c = code(migration())
    const a = c.search(/CREATE TABLE IF NOT EXISTS public\.wallet_topup_sessions/)
    const b = c.search(/CREATE TABLE IF NOT EXISTS public\.momo_transactions/)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
  })

  it("locks every table down, then grants service_role only what it needs, and never DELETE", () => {
    const c = code(migration())
    for (const t of TABLES) {
      expect(c).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`)
      expect(c).toContain(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`)
      expect(c).toContain(`REVOKE ALL ON TABLE public.${t} FROM service_role;`)
    }
    expect(c).not.toMatch(/CREATE POLICY/i)
    expect(c).not.toMatch(/GRANT[^;]*\bDELETE\b/i)
    expect(c).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.momo_transactions TO service_role;")
    expect(c).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.wallet_topup_sessions TO service_role;")
    expect(c).toContain("GRANT SELECT ON TABLE public.momo_claim_attempts TO service_role;")
    expect(c).toContain("GRANT SELECT, INSERT ON TABLE public.momo_reconciliation_runs TO service_role;")
  })

  it("sessions cascade with their auth user; MoMo rows are unlinked, never deleted", () => {
    const c = code(migration())
    expect(c).toMatch(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/)
    expect(c).toMatch(/session_id\s+uuid REFERENCES public\.wallet_topup_sessions\(id\) ON DELETE SET NULL/)
  })

  it("seeds every default setting with ON CONFLICT DO NOTHING", () => {
    const c = code(migration())
    for (const k of ["momo_claim_enabled", "momo_payment_accounts", "momo_account_name", "momo_claim_fee_customer", "momo_claim_fee_dealer",
                     "momo_min_claimable", "momo_max_claimable", "momo_sms_sender_allowlist", "momo_txid_regression_threshold",
                     "momo_auto_claim_review_threshold", "momo_auto_claim_daily_cap"]) {
      expect(c).toContain(`'${k}'`)
    }
    expect(c).toMatch(/ON CONFLICT \(key\) DO NOTHING/)
    expect(c).not.toMatch(/ON CONFLICT \(key\) DO UPDATE/i)
  })
})

describe("0160 run string (migration + self-test)", () => {
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
    for (const label of ["catalog", "fk_rules", "grants", "deny_anon", "deny_authenticated", "settings_defaults", "txid_check", "code_check"]) {
      expect(st).toContain(label)
    }
  })

  it("self-test covers every money-function scenario", () => {
    const st = read(SELFTEST_FILE)
    for (const label of ["fn_catalog", "fn_grants", "fn_deny", "credited", "already_credited", "payment_before_session", "webhook_amount_mismatch",
                         "manual_amount_mismatch", "no_session", "webhook_no_session", "first_claim", "above_review_threshold", "daily_cap",
                         "flagged_not_claimable", "rate_limited", "daily_limit", "too_many_attempts", "admin_credit_flagged",
                         "admin_reason_required", "admin_credit_unparsed", "admin_unflag", "webhook_then_manual", "dealer_fee", "session_quote",
                         "admin_quote_mismatch", "bad_quote", "wallet_lock_first", "ledger_scoped", "setting_descriptions", "suspicious_claimers", "final_balance"]) {
      expect(st).toMatch(new RegExp(`-- ${label}\\b`))
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
  -- Supabase's defaults and 0060's, service_role included, so every REVOKE is really tested.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`
const FIXTURES = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE TABLE public.users (id uuid PRIMARY KEY, role text);
  CREATE TABLE public.wallets (user_id uuid PRIMARY KEY, balance numeric NOT NULL, total_spent numeric NOT NULL DEFAULT 0,
    total_credited numeric DEFAULT 0, updated_at timestamptz);
  CREATE TABLE public.transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, type varchar(50) NOT NULL, source varchar(100),
    amount numeric(15,2) NOT NULL, balance_before numeric(15,2), balance_after numeric(15,2), description text,
    reference_id varchar(100), status varchar(50) DEFAULT 'completed', created_at timestamp DEFAULT now(),
    CONSTRAINT unique_transaction_reference UNIQUE (user_id, reference_id, type));
  CREATE TABLE public.admin_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) UNIQUE NOT NULL, value jsonb NOT NULL, description text,
    updated_at timestamptz DEFAULT now(), updated_by uuid REFERENCES auth.users(id));
  INSERT INTO auth.users VALUES ('5f0c1a9e-0160-4160-8160-000000000001');
  INSERT INTO public.users VALUES ('5f0c1a9e-0160-4160-8160-000000000001', 'admin');
  -- The self-test credits the admin with the largest wallet and reads one dealer's fee.
  INSERT INTO public.wallets (user_id, balance) VALUES ('5f0c1a9e-0160-4160-8160-000000000001', 100);
  INSERT INTO auth.users VALUES ('5f0c1a9e-0160-4160-8160-000000000002');
  INSERT INTO public.users VALUES ('5f0c1a9e-0160-4160-8160-000000000002', 'dealer');
`

const USER = "5f0c1a9e-0160-4160-8160-000000000001"

describe.skipIf(!PGliteCtor)("0160 in PGlite", () => {
  let db: any
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n)
  let seq = 0
  const txid = () => String(10000000 + ++seq)
  const insertTx = (id: string, status = "pending") =>
    db.query("INSERT INTO public.momo_transactions (transaction_id, raw_sms, status) VALUES ($1, 'sms', $2)", [id, status])
  const insertSession = (code: string) =>
    db.query(`INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
              VALUES ($1, $2, 10, 0, 10, now() + interval '1 hour')`, [USER, code])

  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(FIXTURES)
  }, 60_000)

  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    try {
      await expect(db.exec(runString())).rejects.toThrow(/SELFTEST_OK 0160 tables, grants, settings, checks and money functions/)
    } finally {
      await db.exec("ROLLBACK")
    }
    for (const t of TABLES) expect((await one("SELECT to_regclass($1) AS t", [`public.${t}`])).t).toBeNull()
    expect(await count("SELECT count(*) AS n FROM public.admin_settings WHERE key LIKE 'momo_%'")).toBe(0)
    expect(await count("SELECT count(*) AS n FROM pg_proc WHERE proname LIKE '%momo%'")).toBe(0)
    expect(await count("SELECT count(*) AS n FROM public.transactions")).toBe(0)
    expect(Number((await one("SELECT balance AS b FROM public.wallets WHERE user_id = $1", [USER])).b)).toBe(100)
  })

  describe("after apply", () => {
    beforeAll(async () => {
      await db.exec(migration())
      await db.exec(migration()) // idempotent
    })

    it("all four tables exist with RLS on and no policies", async () => {
      for (const t of TABLES) {
        const r = await one("SELECT relrowsecurity AS rls FROM pg_class WHERE oid = to_regclass($1)", [`public.${t}`])
        expect(r?.rls).toBe(true)
        expect(await count("SELECT count(*) AS n FROM pg_policies WHERE tablename = $1", [t])).toBe(0)
      }
    })

    it.each(TABLES.flatMap(t => ["anon", "authenticated"].map(r => [t, r])))("%s: %s has no privilege at all", async (t, role) => {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await one("SELECT has_table_privilege($1, $2, $3) AS ok", [role, `public.${t}`, p])).ok).toBe(false)
      }
    })

    it("service_role has exactly the agreed privileges", async () => {
      const want: Record<string, string[]> = {
        momo_transactions: ["SELECT", "INSERT", "UPDATE"],
        wallet_topup_sessions: ["SELECT", "INSERT", "UPDATE"],
        momo_claim_attempts: ["SELECT"],
        momo_reconciliation_runs: ["SELECT", "INSERT"],
      }
      for (const t of TABLES) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect((await one("SELECT has_table_privilege('service_role', $1, $2) AS ok", [`public.${t}`, p])).ok).toBe(want[t].includes(p))
        }
      }
    })

    it("anon and authenticated are really refused", async () => {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`)
        try {
          for (const t of TABLES) await expect(db.query(`SELECT * FROM public.${t}`)).rejects.toThrow(/permission denied for table/)
        } finally {
          await db.exec("RESET ROLE")
        }
      }
    })

    it("momo_claim_enabled defaults to {\"value\": false} and every default is seeded once", async () => {
      expect((await one("SELECT value AS v FROM public.admin_settings WHERE key = 'momo_claim_enabled'")).v).toEqual({ value: false })
      const rows = (await db.query("SELECT key AS k, value AS v, description AS d FROM public.admin_settings WHERE key LIKE 'momo_%'")).rows
      const by = Object.fromEntries(rows.map((r: any) => [r.k, r.v]))
      expect(by).toEqual({
        momo_claim_enabled: { value: false },
        momo_payment_accounts: { value: [] },
        momo_account_name: { value: "" },
        momo_claim_fee_customer: { value: 0 },
        momo_claim_fee_dealer: { value: 0 },
        momo_min_claimable: { value: 10 },
        momo_max_claimable: { value: 2000 },
        momo_sms_sender_allowlist: { value: ["MobileMoney"] },
        momo_txid_regression_threshold: { value: 1000000 },
        momo_auto_claim_review_threshold: { value: 500 },
        momo_auto_claim_daily_cap: { value: 3000 },
      })
      for (const r of rows) expect(String(r.d ?? "").length).toBeGreaterThan(5)
    })

    it("re-applying does not overwrite an admin's setting", async () => {
      await db.exec(`UPDATE public.admin_settings SET value = '{"value": true}' WHERE key = 'momo_claim_enabled'`)
      await db.exec(migration())
      expect((await one("SELECT value AS v FROM public.admin_settings WHERE key = 'momo_claim_enabled'")).v).toEqual({ value: true })
      await db.exec(`UPDATE public.admin_settings SET value = '{"value": false}' WHERE key = 'momo_claim_enabled'`)
    })

    it("a duplicate transaction_id raises unique_violation", async () => {
      const id = txid()
      await insertTx(id)
      await expect(insertTx(id)).rejects.toThrow(/duplicate key value violates unique constraint/)
    })

    it("transaction_id must be 8 to 15 digits, or X + a uuid for a row with no parsed id", async () => {
      for (const bad of ["1234567", "1234567890123456", "12345678a", "", "x" + "0".repeat(36), "XZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ"]) {
        await expect(insertTx(bad)).rejects.toThrow(/momo_transactions_transaction_id_check/)
      }
      for (const ok of ["12345678", "123456789012345"]) await insertTx(ok)
      const synthetic = (await one("SELECT 'X' || gen_random_uuid() AS id")).id
      await insertTx(synthetic, "unparsed")
      // An admin may later credit an unparsed row: it keeps its synthetic id and becomes claimed.
      await db.query("UPDATE public.momo_transactions SET status = 'claimed' WHERE transaction_id = $1", [synthetic])
    })

    it("status is limited to the six values, and flag_reasons defaults to an empty array", async () => {
      await expect(insertTx(txid(), "paid")).rejects.toThrow(/momo_transactions_status_check/)
      for (const s of ["pending", "claimed", "flagged", "voided", "unparsed", "rejected_sender"]) await insertTx(txid(), s)
      const r = await one("SELECT flag_reasons AS f, attempts_reset_at IS NOT NULL AS a, received_at IS NOT NULL AS rcv FROM public.momo_transactions LIMIT 1")
      expect(r).toEqual({ f: [], a: true, rcv: true })
      await expect(db.query("INSERT INTO public.momo_transactions (transaction_id, status) VALUES ($1, 'pending')", [txid()])).rejects.toThrow(/null value/)
    })

    it("session code KXO4821 violates the check (O is not allowed); valid codes pass", async () => {
      await expect(insertSession("KXO4821")).rejects.toThrow(/wallet_topup_sessions_code_check/)
      for (const bad of ["KX4821","kxm4821", "KXM1821", "KXM48290", "KXI4821", "KXL4821"]) {
        await expect(insertSession(bad)).rejects.toThrow(/wallet_topup_sessions_code_check/)
      }
      await insertSession("KXM4829")
      await expect(insertSession("KXM4829")).rejects.toThrow(/duplicate key/)
    })

    it("a session needs a positive amount, a known status and an existing user", async () => {
      await expect(db.query(`INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at) VALUES ($1, 'ABC2345', 0, 0, 0, now())`, [USER]))
        .rejects.toThrow(/wallet_topup_sessions_amount_check/)
      await expect(db.query(`INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, status, expires_at) VALUES ($1, 'ABC2345', 5, 0, 5, 'paid', now())`, [USER]))
        .rejects.toThrow(/wallet_topup_sessions_status_check/)
      await expect(db.query(`INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at) VALUES (gen_random_uuid(), 'ABC2345', 5, 0, 5, now())`))
        .rejects.toThrow(/foreign key/)
      expect((await one("SELECT status AS s FROM public.wallet_topup_sessions WHERE code = 'KXM4829'")).s).toBe("pending")
    })

    it("momo_transactions.session_id references wallet_topup_sessions", async () => {
      await expect(db.query("INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, session_id) VALUES ($1, 's', 'pending', gen_random_uuid())", [txid()]))
        .rejects.toThrow(/foreign key/)
    })

    it("deleting an auth user removes their sessions and unlinks (keeps) their MoMo rows", async () => {
      const gone = "5f0c1a9e-0160-4160-8160-0000000000de"
      await db.query("INSERT INTO auth.users VALUES ($1)", [gone])
      const sid = (await one(`INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
                              VALUES ($1, 'DEW2345', 10, 0, 10, now() + interval '1 hour') RETURNING id`, [gone])).id
      const id = txid()
      await db.query("INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, session_id) VALUES ($1, 's', 'flagged', $2)", [id, sid])
      await db.query("DELETE FROM auth.users WHERE id = $1", [gone])
      expect(await count("SELECT count(*) AS n FROM public.wallet_topup_sessions WHERE id = $1", [sid])).toBe(0)
      const row = await one("SELECT status, session_id FROM public.momo_transactions WHERE transaction_id = $1", [id])
      expect(row).toEqual({ status: "flagged", session_id: null })
    })

    it("momo_claim_attempts accepts the eight results and nothing else", async () => {
      for (const r of ["credited", "under_review", "already_credited", "not_matched", "no_session", "rate_limited", "daily_limit", "feature_off"]) {
        await db.query("INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES ($1, 'NOSESSION', $2)", [USER, r])
      }
      await expect(db.query("INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES ($1, 'x', 'ok')", [USER]))
        .rejects.toThrow(/momo_claim_attempts_result_check/)
    })

    it("momo_reconciliation_runs defaults missing_txids to an empty array", async () => {
      await db.query("INSERT INTO public.momo_reconciliation_runs (admin_id) VALUES ($1)", [USER])
      expect((await one("SELECT missing_txids AS m FROM public.momo_reconciliation_runs LIMIT 1")).m).toEqual([])
    })

    it("the agreed indexes exist", async () => {
      const idx = async (t: string): Promise<string[]> =>
        (await db.query("SELECT indexdef AS d FROM pg_indexes WHERE tablename = $1", [t])).rows.map((r: any) => r.d as string)
      expect((await idx("wallet_topup_sessions")).some((d: string) => /\(user_id, status, expires_at\)/.test(d))).toBe(true)
      const a = await idx("momo_claim_attempts")
      expect(a.some((d: string) => /\(user_id, created_at\)/.test(d))).toBe(true)
      expect(a.some((d: string) => /\(transaction_id, created_at\)/.test(d))).toBe(true)
    })

    // ─────────────── Money functions (Task 5) ───────────────
    describe("money functions", () => {
      const RESULTS = ["credited", "under_review", "already_credited", "not_matched", "no_session", "rate_limited", "daily_limit", "feature_off"]
      const seen = new Set<string>()
      let codeSeq = 0
      const nextCode = () => {
        const n = codeSeq++
        const d = (k: number) => String(2 + (Math.floor(n / 8 ** k) % 8))
        return "TST" + d(3) + d(2) + d(1) + d(0)
      }
      const mkUser = async (opts: { role?: string; balance?: number; wallet?: boolean } = {}) => {
        const id = crypto.randomUUID()
        await db.query("INSERT INTO auth.users VALUES ($1)", [id])
        await db.query("INSERT INTO public.users VALUES ($1, $2)", [id, opts.role ?? "user"])
        if (opts.wallet !== false) await db.query("INSERT INTO public.wallets (user_id, balance) VALUES ($1, $2)", [id, opts.balance ?? 0])
        return id
      }
      /** A prior claimed row for the user today, so first_claim does not fire. */
      const season = async (user: string, net = 1) => {
        await db.query(`INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount, net_amount, fee, claimed_by, claimed_at)
                        VALUES ($1, 'sms', 'claimed', $2, $2, 0, $3, now())`, [txid(), net, user])
      }
      /** A MoMo row received 5 minutes ago (after a session created 10 minutes ago). */
      const momo = async (amount: number | null, opts: { status?: string; receivedAgo?: string } = {}) => {
        const id = txid()
        await db.query(`INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount, received_at)
                        VALUES ($1, 'sms', $2, $3, now() - $4::interval)`, [id, opts.status ?? "pending", amount, opts.receivedAgo ?? "5 minutes"])
        return id
      }
      const session = async (user: string, amount: number, opts: { createdAgo?: string; expiresIn?: string; status?: string; fee?: number } = {}) => {
        const code = nextCode()
        const fee = opts.fee ?? 0
        const r = await one(`INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, status, created_at, expires_at)
                             VALUES ($1, $2, $3, $7, $3::numeric - $7::numeric, $4, now() - $5::interval, now() + $6::interval) RETURNING id`,
          [user, code, amount, opts.status ?? "pending", opts.createdAgo ?? "10 minutes", opts.expiresIn ?? "1 hour", fee])
        return { id: r.id as string, code }
      }
      const rec = (r: string) => { seen.add(r); return r }
      /** Move a user's attempts out of the 30-second window (the 24-hour count is unchanged). */
      const cool = (user: string) =>
        db.query("UPDATE public.momo_claim_attempts SET created_at = created_at - interval '1 minute' WHERE user_id = $1", [user])
      const manual = async (user: string, id: string, sessionId: string | null = null) =>
        rec((await one("SELECT public.claim_momo_via_session($1, $2, $3) AS r", [user, id, sessionId])).r)
      const webhook = async (code: string, id: string) =>
        rec((await one("SELECT public.claim_via_wallet_topup_session($1, $2) AS r", [code, id])).r)
      const adminCredit = async (id: string, target: string, reason: string, amount: number | null = null) =>
        rec((await one("SELECT public.admin_credit_momo_transaction($1, $2, $3, $4, $5) AS r", [id, target, USER, reason, amount])).r)
      const wallet = async (user: string) => {
        const r = await one("SELECT balance::numeric AS b, total_credited::numeric AS c FROM public.wallets WHERE user_id = $1", [user])
        return { balance: Number(r.b), credited: Number(r.c) }
      }
      const row = (id: string) => one("SELECT * FROM public.momo_transactions WHERE transaction_id = $1", [id])
      const sess = (id: string) => one("SELECT * FROM public.wallet_topup_sessions WHERE id = $1", [id])
      const ledger = (id: string) => db.query("SELECT * FROM public.transactions WHERE reference_id = $1", ["MOMO-" + id]).then((r: any) => r.rows)
      const setSetting = (key: string, v: unknown) =>
        db.query("UPDATE public.admin_settings SET value = jsonb_build_object('value', $2::jsonb) WHERE key = $1", [key, JSON.stringify(v)])

      it("credited under own session: wallet +net, one ledger row MOMO-<txid>, row and session claimed", async () => {
        const u = await mkUser({ balance: 5 })
        await season(u)
        const s = await session(u, 20)
        const id = await momo(20)
        expect(await manual(u, id, s.id)).toBe("credited")
        expect(await wallet(u)).toEqual({ balance: 25, credited: 20 })
        const l = await ledger(id)
        expect(l).toHaveLength(1)
        expect(l[0]).toMatchObject({ user_id: u, type: "credit", source: "momo_claim", status: "completed" })
        expect(Number(l[0].amount)).toBe(20)
        expect(Number(l[0].balance_before)).toBe(5)
        expect(Number(l[0].balance_after)).toBe(25)
        const r = await row(id)
        expect(r).toMatchObject({ status: "claimed", claimed_by: u, session_id: s.id })
        expect(Number(r.fee)).toBe(0)
        expect(Number(r.net_amount)).toBe(20)
        expect(r.claimed_at).not.toBeNull()
        expect(await sess(s.id)).toMatchObject({ status: "claimed", claimed_transaction_id: id })
      })

      it("a second call on the same txid answers already_credited and credits nothing", async () => {
        const u = await mkUser()
        await season(u)
        const s = await session(u, 15)
        const id = await momo(15)
        expect(await manual(u, id, s.id)).toBe("credited")
        await session(u, 15)
        expect(await manual(u, id)).toBe("already_credited")
        expect(await webhook(s.code, id)).toBe("no_session")
        expect((await wallet(u)).balance).toBe(15)
        expect(await ledger(id)).toHaveLength(1)
      })

      it("without a session id it uses the caller's newest open session", async () => {
        const u = await mkUser()
        await season(u)
        await session(u, 30)
        const id = await momo(30)
        expect(await manual(u, id)).toBe("credited")
        expect((await wallet(u)).balance).toBe(30)
      })

      it("payment received before the session was created -> not_matched", async () => {
        const u = await mkUser()
        await season(u)
        const s = await session(u, 10, { createdAgo: "1 minute" })
        const id = await momo(10, { receivedAgo: "5 minutes" })
        expect(await manual(u, id, s.id)).toBe("not_matched")
        expect((await row(id)).status).toBe("pending")
        expect((await wallet(u)).balance).toBe(0)
      })

      it("webhook with the wrong amount flags amount_mismatch, links the session, credits nothing", async () => {
        const u = await mkUser()
        await season(u)
        const s = await session(u, 10)
        const id = await momo(10.01)
        expect(await webhook(s.code, id)).toBe("under_review")
        const r = await row(id)
        expect(r).toMatchObject({ status: "flagged", session_id: s.id, claimed_by: null })
        expect(r.flag_reasons).toEqual(["amount_mismatch"])
        expect((await sess(s.id)).status).toBe("pending")
        expect((await wallet(u)).balance).toBe(0)
        expect(await ledger(id)).toHaveLength(0)
      })

      it("manual claim with the wrong amount -> not_matched, row unchanged", async () => {
        const u = await mkUser()
        await season(u)
        const s = await session(u, 10)
        const id = await momo(9.99)
        expect(await manual(u, id, s.id)).toBe("not_matched")
        const r = await row(id)
        expect(r).toMatchObject({ status: "pending", session_id: null })
        expect(r.flag_reasons).toEqual([])
        expect((await wallet(u)).balance).toBe(0)
      })

      it("manual with no open session -> no_session, logged under NOSESSION", async () => {
        const u = await mkUser()
        const id = await momo(10)
        expect(await manual(u, id)).toBe("no_session")
        await session(u, 10, { expiresIn: "-1 minute" })
        expect(await manual(u, id)).toBe("no_session")
        const other = await mkUser()
        const s = await session(other, 10)
        expect(await manual(u, id, s.id)).toBe("no_session") // someone else's session
        const a = (await db.query("SELECT transaction_id, result FROM public.momo_claim_attempts WHERE user_id = $1", [u])).rows
        expect(a).toHaveLength(3)
        for (const x of a) expect(x).toEqual({ transaction_id: "NOSESSION", result: "no_session" })
        expect((await row(id)).status).toBe("pending")
      })

      it("webhook with no live session -> no_session and nothing changes (unknown, expired, claimed, created after payment)", async () => {
        const u = await mkUser()
        await season(u)
        const id = await momo(10)
        const expired = await session(u, 10, { expiresIn: "-1 minute" })
        const claimed = await session(u, 10, { status: "claimed" })
        const late = await session(u, 10, { createdAgo: "1 minute" })
        for (const c of ["ZZZ9999", expired.code, claimed.code, late.code]) expect(await webhook(c, id)).toBe("no_session")
        const r = await row(id)
        expect(r).toMatchObject({ status: "pending", session_id: null })
        expect((await wallet(u)).balance).toBe(0)
        expect(await count("SELECT count(*) AS n FROM public.momo_claim_attempts WHERE user_id = $1", [u])).toBe(0)
      })

      it("first claim of a user -> under_review with first_claim; admin approve credits the linked session's user", async () => {
        const u = await mkUser()
        const s = await session(u, 12)
        const id = await momo(12)
        expect(await manual(u, id, s.id)).toBe("under_review")
        const r = await row(id)
        expect(r).toMatchObject({ status: "flagged", session_id: s.id, claimed_by: null })
        expect(r.flag_reasons).toEqual(["first_claim"])
        expect((await sess(s.id)).status).toBe("pending")
        expect((await wallet(u)).balance).toBe(0)
        expect(await adminCredit(id, u, "approved first claim")).toBe("credited")
        expect((await wallet(u)).balance).toBe(12)
        expect(await row(id)).toMatchObject({ status: "claimed", claimed_by: u, credited_by_admin: USER, admin_reason: "approved first claim" })
        expect(await sess(s.id)).toMatchObject({ status: "claimed", claimed_transaction_id: id })
      })

      it("webhook first claim also goes to review", async () => {
        const u = await mkUser()
        const s = await session(u, 12)
        const id = await momo(12)
        expect(await webhook(s.code, id)).toBe("under_review")
        expect((await row(id)).flag_reasons).toEqual(["first_claim"])
      })

      it("net 500.01 -> above_review_threshold; net 500.00 -> credited", async () => {
        const u = await mkUser()
        await season(u)
        const s1 = await session(u, 500.01)
        const id1 = await momo(500.01)
        expect(await manual(u, id1, s1.id)).toBe("under_review")
        expect((await row(id1)).flag_reasons).toEqual(["above_review_threshold"])
        const s2 = await session(u, 500)
        const id2 = await momo(500)
        expect(await manual(u, id2, s2.id)).toBe("credited")
        expect((await wallet(u)).balance).toBe(500)
      })

      it("crossing the daily cap -> daily_cap", async () => {
        const u = await mkUser()
        await season(u, 2950)
        const s = await session(u, 50.01)
        const id = await momo(50.01)
        expect(await manual(u, id, s.id)).toBe("under_review")
        expect((await row(id)).flag_reasons).toEqual(["daily_cap"])
        const s2 = await session(u, 50)
        const id2 = await momo(50)
        expect(await manual(u, id2, s2.id)).toBe("credited") // exactly at the cap
      })

      it("a flagged row cannot be claimed manually or by webhook", async () => {
        const u = await mkUser()
        await season(u)
        const s = await session(u, 10)
        const id = await momo(10, { status: "flagged" })
        expect(await manual(u, id, s.id)).toBe("not_matched")
        expect(await webhook(s.code, id)).toBe("not_matched")
        for (const st of ["voided", "unparsed", "rejected_sender"]) {
          await cool(u)
          const other = await momo(10, { status: st })
          expect(await manual(u, other, s.id)).toBe("not_matched")
        }
        expect((await wallet(u)).balance).toBe(0)
        expect((await row(id)).status).toBe("flagged")
      })

      it("a row claimed by someone else -> not_matched for the other user", async () => {
        const a = await mkUser(); await season(a)
        const b = await mkUser(); await season(b)
        const sa = await session(a, 10)
        const sb = await session(b, 10)
        const id = await momo(10)
        expect(await manual(a, id, sa.id)).toBe("credited")
        expect(await manual(b, id, sb.id)).toBe("not_matched")
        expect((await wallet(b)).balance).toBe(0)
        expect((await sess(sb.id)).status).toBe("pending")
      })

      it("4th attempt within 30 s -> rate_limited (logged NOSESSION)", async () => {
        const u = await mkUser()
        for (let i = 0; i < 3; i++) expect(await manual(u, txid())).toBe("no_session")
        expect(await manual(u, txid())).toBe("rate_limited")
        const last = await one("SELECT transaction_id, result FROM public.momo_claim_attempts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [u])
        expect(last).toEqual({ transaction_id: "NOSESSION", result: "rate_limited" })
      })

      it("20 failed attempts in 24 h -> daily_limit; successes do not count", async () => {
        const u = await mkUser()
        await db.query(`INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result, created_at)
                        SELECT $1, 'NOSESSION', CASE WHEN g <= 19 THEN 'not_matched' ELSE 'credited' END, now() - interval '1 hour'
                        FROM generate_series(1, 25) g`, [u])
        await db.query(`INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result, created_at)
                        VALUES ($1, 'NOSESSION', 'not_matched', now() - interval '25 hours')`, [u])
        expect(await manual(u, txid())).toBe("no_session") // 19 + this one = 20 failed
        expect(await manual(u, txid())).toBe("daily_limit")
      })

      it("5 failed attempts on one txid (any users) flag it too_many_attempts", async () => {
        const id = await momo(10)
        for (let i = 0; i < 5; i++) {
          const u = await mkUser()
          const s = await session(u, 11) // wrong amount
          expect(await manual(u, id, s.id)).toBe("not_matched")
          expect((await row(id)).status).toBe(i < 4 ? "pending" : "flagged")
        }
        expect((await row(id)).flag_reasons).toEqual(["too_many_attempts"])
        expect(await count("SELECT count(*) AS n FROM public.momo_claim_attempts WHERE transaction_id = $1", [id])).toBe(5)
      })

      it("admin unflag: flagged -> pending, records who/why, resets the per-txid counter", async () => {
        const id = await momo(10)
        for (let i = 0; i < 5; i++) {
          const u = await mkUser()
          const s = await session(u, 11)
          await manual(u, id, s.id)
        }
        expect((await row(id)).status).toBe("flagged")
        await expect(db.query("SELECT public.admin_unflag_momo_transaction($1, $2, '')", [id, USER])).rejects.toThrow(/BAD_INPUT/)
        expect((await one("SELECT public.admin_unflag_momo_transaction($1, $2, 'customer called') AS r", [id, USER])).r).toBe("unflagged")
        const r = await row(id)
        expect(r).toMatchObject({ status: "pending", unflagged_by: USER, unflag_reason: "customer called" })
        expect(r.unflagged_at).not.toBeNull()
        // The counter restarts: one more failure does not re-flag.
        const u = await mkUser()
        const s = await session(u, 11)
        expect(await manual(u, id, s.id)).toBe("not_matched")
        expect((await row(id)).status).toBe("pending")
        await expect(db.query("SELECT public.admin_unflag_momo_transaction($1, $2, 'again')", [id, USER])).rejects.toThrow(/BAD_STATE/)
      })

      it("admin credit of a flagged row credits once; a second admin call -> already_credited", async () => {
        const u = await mkUser({ balance: 1 })
        const id = await momo(40, { status: "flagged" })
        expect(await adminCredit(id, u, "checked statement")).toBe("credited")
        expect(await adminCredit(id, u, "checked statement")).toBe("already_credited")
        expect(await wallet(u)).toEqual({ balance: 41, credited: 40 })
        expect(await ledger(id)).toHaveLength(1)
        expect(await row(id)).toMatchObject({ status: "claimed", claimed_by: u, credited_by_admin: USER })
      })

      it("admin credit skips the per-user checks (first claim, threshold, cap)", async () => {
        const u = await mkUser()
        const id = await momo(3500)
        expect(await adminCredit(id, u, "big payment checked")).toBe("credited")
        expect((await wallet(u)).balance).toBe(3500)
      })

      it("admin credit with an empty, blank or 201-char reason -> error, nothing written", async () => {
        const u = await mkUser()
        const id = await momo(10)
        for (const bad of ["", "   ", "x".repeat(201)]) {
          await expect(db.query("SELECT public.admin_credit_momo_transaction($1, $2, $3, $4)", [id, u, USER, bad])).rejects.toThrow(/BAD_INPUT/)
        }
        await expect(db.query("SELECT public.admin_credit_momo_transaction($1, $2, $3, NULL)", [id, u, USER])).rejects.toThrow(/BAD_INPUT/)
        expect((await row(id)).status).toBe("pending")
        expect((await wallet(u)).balance).toBe(0)
      })

      it("admin credit of an unparsed row needs p_amount (the sent amount), and sets it", async () => {
        const u = await mkUser()
        const id = await momo(null, { status: "unparsed" })
        await expect(adminCredit(id, u, "read the SMS")).rejects.toThrow(/BAD_INPUT/)
        await expect(adminCredit(id, u, "read the SMS", 0)).rejects.toThrow(/BAD_INPUT/)
        await expect(adminCredit(id, u, "read the SMS", 1.005)).rejects.toThrow(/BAD_INPUT/)
        expect(await adminCredit(id, u, "read the SMS", 25.5)).toBe("credited")
        const r = await row(id)
        expect(Number(r.amount)).toBe(25.5)
        expect(Number(r.net_amount)).toBe(25.5)
        expect((await wallet(u)).balance).toBe(25.5)
      })

      it("admin credit with p_amount different from the parsed amount -> error; equal is fine", async () => {
        const u = await mkUser()
        const id = await momo(10)
        await expect(adminCredit(id, u, "typo", 11)).rejects.toThrow(/BAD_INPUT/)
        expect(await adminCredit(id, u, "matches", 10)).toBe("credited")
      })

      it("admin credit refuses voided and rejected_sender rows, and unknown txids", async () => {
        const u = await mkUser()
        for (const st of ["voided", "rejected_sender"]) {
          const id = await momo(10, { status: st })
          await expect(adminCredit(id, u, "no")).rejects.toThrow(/BAD_STATE/)
        }
        await expect(adminCredit(txid(), u, "no")).rejects.toThrow(/NOT_FOUND/)
        expect((await wallet(u)).balance).toBe(0)
      })

      it("a user with no wallet: the claim raises and nothing is written", async () => {
        const u = await mkUser({ wallet: false })
        await season(u)
        const s = await session(u, 10)
        const id = await momo(10)
        await expect(db.query("SELECT public.claim_momo_via_session($1, $2, $3)", [u, id, s.id])).rejects.toThrow(/NO_WALLET/)
        expect((await row(id)).status).toBe("pending")
        expect((await sess(s.id)).status).toBe("pending")
        expect(await count("SELECT count(*) AS n FROM public.momo_claim_attempts WHERE user_id = $1", [u])).toBe(0)
        await expect(adminCredit(id, u, "no wallet")).rejects.toThrow(/NO_WALLET/)
      })

      it("webhook then manual on the same txid -> exactly one credit (Review Focus 2)", async () => {
        const u = await mkUser()
        await season(u)
        const s = await session(u, 25)
        const id = await momo(25)
        expect(await webhook(s.code, id)).toBe("credited")
        await session(u, 25)
        expect(await manual(u, id)).toBe("already_credited")
        const other = await mkUser(); await season(other)
        const so = await session(other, 25)
        expect(await manual(other, id, so.id)).toBe("not_matched")
        expect(await webhook(so.code, id)).toBe("not_matched")
        expect((await wallet(u)).balance).toBe(25)
        expect((await wallet(other)).balance).toBe(0)
        expect(await ledger(id)).toHaveLength(1)
      })

      it("a ledger row MOMO-<txid> already present -> already_credited, nothing changes", async () => {
        const u = await mkUser()
        await season(u)
        const s = await session(u, 10)
        const id = await momo(10)
        await db.query("INSERT INTO public.transactions (user_id, type, source, amount, reference_id) VALUES ($1, 'credit', 'momo_claim', 10, $2)", [u, "MOMO-" + id])
        expect(await manual(u, id, s.id)).toBe("already_credited")
        expect((await wallet(u)).balance).toBe(0)
        expect((await row(id)).status).toBe("pending")
      })

      it("admin credit with no linked session: dealer pays the dealer fee, others the customer fee, rounded up to the pesewa", async () => {
        try {
          await setSetting("momo_claim_fee_customer", 1)
          await setSetting("momo_claim_fee_dealer", 1.5)
          const d = await mkUser({ role: "dealer" })
          const c = await mkUser({ role: "user" })
          const idd = await momo(10.01)
          expect(await adminCredit(idd, d, "fee check")).toBe("credited")
          // 10.01 * 1.5% = 0.15015 -> 0.16
          expect(Number((await row(idd)).fee)).toBe(0.16)
          expect((await wallet(d)).balance).toBe(9.85)
          const idc = await momo(10.01)
          expect(await adminCredit(idc, c, "fee check")).toBe("credited")
          // 10.01 * 1% = 0.1001 -> 0.11
          expect(Number((await row(idc)).fee)).toBe(0.11)
          expect((await wallet(c)).balance).toBe(9.9)
          // A non-number setting falls back to the default (0).
          await setSetting("momo_claim_fee_dealer", "2")
          const idd2 = await momo(10)
          expect(await adminCredit(idd2, d, "fee check")).toBe("credited")
          expect(Number((await row(idd2)).fee)).toBe(0)
        } finally {
          await setSetting("momo_claim_fee_customer", 0)
          await setSetting("momo_claim_fee_dealer", 0)
        }
      })

      it("manual and webhook credits use the session's quoted fee and net, even after the fee setting changes", async () => {
        try {
          const u = await mkUser({ role: "dealer" }); await season(u)
          const s1 = await session(u, 10, { fee: 0.5 }) // quoted 5 %
          const s2 = await session(u, 20, { fee: 0.3 })
          await setSetting("momo_claim_fee_dealer", 1)
          await setSetting("momo_claim_fee_customer", 1)
          const id1 = await momo(10)
          expect(await manual(u, id1, s1.id)).toBe("credited")
          expect(Number((await row(id1)).fee)).toBe(0.5)
          expect(Number((await row(id1)).net_amount)).toBe(9.5)
          const id2 = await momo(20)
          expect(await webhook(s2.code, id2)).toBe("credited")
          expect(Number((await row(id2)).net_amount)).toBe(19.7)
          expect((await wallet(u)).balance).toBe(29.2)
          expect(Number((await ledger(id2))[0].amount)).toBe(19.7)
        } finally {
          await setSetting("momo_claim_fee_customer", 0)
          await setSetting("momo_claim_fee_dealer", 0)
        }
      })

      it("the review threshold and daily cap look at the quoted net", async () => {
        const u = await mkUser(); await season(u)
        const s = await session(u, 500.5, { fee: 0.5 }) // net 500.00: not above 500
        const id = await momo(500.5)
        expect(await manual(u, id, s.id)).toBe("credited")
        expect((await wallet(u)).balance).toBe(500)
      })

      it("admin approve of a first claim uses the linked session's quote", async () => {
        try {
          const u = await mkUser()
          const s = await session(u, 10, { fee: 0.4 })
          const id = await momo(10)
          expect(await manual(u, id, s.id)).toBe("under_review")
          await setSetting("momo_claim_fee_customer", 2)
          expect(await adminCredit(id, u, "approve")).toBe("credited")
          expect(Number((await row(id)).net_amount)).toBe(9.6)
          expect((await wallet(u)).balance).toBe(9.6)
        } finally {
          await setSetting("momo_claim_fee_customer", 0)
        }
      })

      it("admin approve of an amount_mismatch row never pays the session's (bigger) quote: it recomputes on the sent amount", async () => {
        const u = await mkUser(); await season(u)
        const s = await session(u, 100, { fee: 1 })
        const id = await momo(10)
        expect(await webhook(s.code, id)).toBe("under_review")
        expect(await adminCredit(id, u, "paid less than quoted")).toBe("credited")
        expect(Number((await row(id)).net_amount)).toBe(10)
        expect((await wallet(u)).balance).toBe(10)
        expect((await sess(s.id)).status).toBe("pending") // the 100 quote was not paid
      })

      it("a session whose quote does not add up is refused (BAD_STATE), nothing written", async () => {
        const u = await mkUser(); await season(u)
        const s = await session(u, 10)
        await db.query("UPDATE public.wallet_topup_sessions SET net_amount = 11 WHERE id = $1", [s.id])
        const id = await momo(10)
        await expect(db.query("SELECT public.claim_momo_via_session($1, $2, $3)", [u, id, s.id])).rejects.toThrow(/BAD_STATE/)
        expect((await wallet(u)).balance).toBe(0)
        expect((await row(id)).status).toBe("pending")
      })

      it("per-user checks run under the wallet lock: a first claim by a user with no wallet raises NO_WALLET instead of flagging", async () => {
        const u = await mkUser({ wallet: false })
        const s = await session(u, 10)
        const id = await momo(10)
        await expect(db.query("SELECT public.claim_momo_via_session($1, $2, $3)", [u, id, s.id])).rejects.toThrow(/NO_WALLET/)
        await expect(db.query("SELECT public.claim_via_wallet_topup_session($1, $2)", [s.code, id])).rejects.toThrow(/NO_WALLET/)
        expect((await row(id)).status).toBe("pending")
        // And in the source, the wallet lock comes before the first per-user check.
        const src = (await one("SELECT prosrc AS s FROM pg_proc WHERE oid = 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)'::regprocedure")).s as string
        const lock = src.search(/FROM public\.wallets w WHERE w\.user_id = p_user FOR UPDATE/)
        expect(lock).toBeGreaterThan(-1)
        expect(lock).toBeLessThan(src.indexOf("first_claim"))
        expect(lock).toBeLessThan(src.indexOf("momo_auto_claim_daily_cap"))
      })

      it("the ledger check is scoped to the credited user (uses the unique index): another user's MOMO-<txid> row does not block", async () => {
        const src = (await one("SELECT prosrc AS s FROM pg_proc WHERE oid = 'public.momo_credit_wallet(text,uuid,numeric)'::regprocedure")).s as string
        expect(src).toMatch(/t\.user_id = p_user AND t\.reference_id = v_ref AND t\.type = 'credit'/)
        // Cross-user safety comes from the momo row lock + status, proven by the "claimed by someone else" test.
      })

      it("setting descriptions match the code: fee is a percent, review threshold is 'above'", async () => {
        const d = async (k: string) => (await one("SELECT description AS d FROM public.admin_settings WHERE key = $1", [k])).d as string
        for (const k of ["momo_claim_fee_customer", "momo_claim_fee_dealer"]) {
          expect(await d(k)).toMatch(/percent/i)
          expect(await d(k)).not.toMatch(/GHS/)
        }
        expect(await d("momo_auto_claim_review_threshold")).toMatch(/above/i)
        expect(await d("momo_auto_claim_review_threshold")).not.toMatch(/at or above/i)
      })

      it("every attempt is logged with the result returned, and every result is in the CHECK list", async () => {
        const rows = (await db.query("SELECT DISTINCT result FROM public.momo_claim_attempts")).rows.map((r: any) => r.result)
        for (const r of rows) expect(RESULTS).toContain(r)
        for (const r of seen) if (r !== "unflagged") expect(RESULTS).toContain(r)
        const def = (await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'momo_claim_attempts_result_check'")).d
        for (const r of ["credited", "under_review", "already_credited", "not_matched", "no_session", "rate_limited", "daily_limit"]) {
          expect(def).toContain(`'${r}'`)
          expect([...seen]).toContain(r)
        }
      })

      it("momo_suspicious_claimers: counts per user in the last 24 h, honours threshold and limit, service_role only", async () => {
        const mk = async (n: number, hoursAgo = 0) => {
          const u = (await one("SELECT gen_random_uuid() AS u")).u
          await db.query(
            `INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result, created_at)
             SELECT $1, '88888888', 'not_matched', now() - ($3 || ' hours')::interval FROM generate_series(1, $2::int)`,
            [u, n, String(hoursAgo)],
          )
          return u
        }
        const a = await mk(8)
        const b = await mk(5)
        const c = await mk(4)
        const old = await mk(9, 30)
        const res = (await db.query("SELECT user_id, attempts FROM public.momo_suspicious_claimers(5, 100)")).rows
        const got = Object.fromEntries(res.map((r: any) => [r.user_id, Number(r.attempts)]))
        expect(got[a]).toBe(8)
        expect(got[b]).toBe(5)
        expect(got[c]).toBeUndefined()
        expect(got[old]).toBeUndefined()
        const order = res.map((r: any) => Number(r.attempts))
        expect(order).toEqual([...order].sort((x: number, y: number) => y - x))
        expect((await db.query("SELECT * FROM public.momo_suspicious_claimers(5, 1)")).rows).toHaveLength(1)
        expect((await db.query("SELECT * FROM public.momo_suspicious_claimers(5, 0)")).rows).toHaveLength(1)
        const f = "public.momo_suspicious_claimers(int,int)"
        for (const role of ["anon", "authenticated", "public"]) {
          expect((await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, f])).ok, role).toBe(false)
        }
        expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok).toBe(true)
        const sec = await one("SELECT prosecdef AS d, proconfig AS c FROM pg_proc WHERE oid = $1::regprocedure", [f])
        expect(sec.d).toBe(true)
        expect(sec.c).toEqual(['search_path=""'])
      })

      it("EXECUTE: nobody may call claim_momo_transaction or the helpers; only service_role calls the four entry points", async () => {
        const entry = [
          "public.claim_via_wallet_topup_session(text,text)",
          "public.claim_momo_via_session(uuid,text,uuid)",
          "public.admin_credit_momo_transaction(text,uuid,uuid,text,numeric)",
          "public.admin_unflag_momo_transaction(text,uuid,text)",
        ]
        const internal = [
          "public.claim_momo_transaction(text,uuid,uuid,boolean,text)",
          "public.momo_credit_wallet(text,uuid,numeric)",
          "public.momo_claim_fee(uuid,numeric)",
          "public.momo_setting_numeric(text,numeric)",
        ]
        for (const f of [...entry, ...internal]) {
          for (const role of ["anon", "authenticated", "public"]) {
            expect((await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, f])).ok, `${role} ${f}`).toBe(false)
          }
          const sec = await one("SELECT prosecdef AS d, proconfig AS c FROM pg_proc WHERE oid = $1::regprocedure", [f])
          expect(sec.d).toBe(true)
          expect(sec.c).toEqual(['search_path=""'])
        }
        for (const f of entry) expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok).toBe(true)
        for (const f of internal) expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok, f).toBe(false)
        await db.exec("SET ROLE authenticated")
        try {
          await expect(db.query("SELECT public.claim_momo_via_session(gen_random_uuid(), '12345678', NULL)")).rejects.toThrow(/permission denied for function/)
        } finally {
          await db.exec("RESET ROLE")
        }
      })
    })
  })
})
