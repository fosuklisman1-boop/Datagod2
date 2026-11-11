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
    for (const label of ["catalog", "grants", "deny_anon", "deny_authenticated", "settings_defaults", "txid_check", "code_check"]) {
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
  -- Supabase's defaults and 0060's, service_role included, so every REVOKE is really tested.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
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
  CREATE TABLE public.admin_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) UNIQUE NOT NULL, value jsonb NOT NULL, description text,
    updated_at timestamptz DEFAULT now(), updated_by uuid REFERENCES auth.users(id));
  INSERT INTO auth.users VALUES ('5f0c1a9e-0160-4160-8160-000000000001');
  INSERT INTO public.users VALUES ('5f0c1a9e-0160-4160-8160-000000000001', 'admin');
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
      await expect(db.exec(runString())).rejects.toThrow(/SELFTEST_OK 0160/)
    } finally {
      await db.exec("ROLLBACK")
    }
    for (const t of TABLES) expect((await one("SELECT to_regclass($1) AS t", [`public.${t}`])).t).toBeNull()
    expect(await count("SELECT count(*) AS n FROM public.admin_settings WHERE key LIKE 'momo_%'")).toBe(0)
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
      const idx = async (t: string) => (await db.query("SELECT indexdef AS d FROM pg_indexes WHERE tablename = $1", [t])).rows.map((r: any) => r.d as string)
      expect((await idx("wallet_topup_sessions")).some(d => /\(user_id, status, expires_at\)/.test(d))).toBe(true)
      const a = await idx("momo_claim_attempts")
      expect(a.some(d => /\(user_id, created_at\)/.test(d))).toBe(true)
      expect(a.some(d => /\(transaction_id, created_at\)/.test(d))).toBe(true)
    })
  })
})
