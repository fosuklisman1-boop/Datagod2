// lib/momo-claim/migration-0161.test.ts
// migrations/0161_momo_first_claim_review_toggle.sql and its self-test. 0160 is applied in production and never edited;
// 0161 replaces claim_momo_transaction with the same body except that first_claim is added only while the admin setting
// momo_first_claim_review is not exactly JSON false. Same style as migration.test.ts.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { createHash } from "crypto"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")

const FILE = "0161_momo_first_claim_review_toggle.sql"
const SELFTEST_FILE = "0161_momo_first_claim_review_toggle.selftest.sql"
const BASE = "0160_momo_send_and_claim.sql"
const migration = () => read(FILE)
const FN_SIG = "public.claim_momo_transaction(text,uuid,uuid,boolean,text)"

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map(l => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0161: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex(l => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0161: run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0161: run string does not end by raising")
  return run
}
const runString = () => buildRunString(migration(), read(SELFTEST_FILE))

/** The claim_momo_transaction definition (CREATE ... $fn$;) from a migration, comments stripped, blank lines dropped. */
function fnBody(sql: string): string[] {
  const c = code(sql)
  const start = c.indexOf("CREATE OR REPLACE FUNCTION public.claim_momo_transaction(")
  if (start < 0) throw new Error("no claim_momo_transaction")
  const bodyStart = c.indexOf("$fn$", start)
  const end = c.indexOf("$fn$;", bodyStart + 4)
  return c.slice(start, end + 5).split("\n").map(l => l.trim()).filter(Boolean)
}

const DECL = "v_review  boolean;"
const ASSIGN = "v_review := (SELECT s.value -> 'value' FROM public.admin_settings s WHERE s.key = 'momo_first_claim_review') IS DISTINCT FROM 'false'::jsonb;"
const GATE = "IF v_review AND NOT EXISTS (SELECT 1 FROM public.momo_transactions m WHERE m.claimed_by = p_user AND m.status = 'claimed') THEN"
const BASE_GATE = "IF NOT EXISTS (SELECT 1 FROM public.momo_transactions m WHERE m.claimed_by = p_user AND m.status = 'claimed') THEN"

/** Undo exactly the three 0161 changes (each must occur exactly once); every other line must then equal 0160's. */
function undo0161(lines: string[]): string[] {
  const out = [...lines]
  for (const [line, replacement] of [[DECL, null], [ASSIGN, null], [GATE, BASE_GATE]] as const) {
    const hits = out.filter(l => l === line).length
    if (hits !== 1) throw new Error(`expected exactly one [${line}], found ${hits}`)
    const i = out.indexOf(line)
    if (replacement === null) out.splice(i, 1)
    else out[i] = replacement
  }
  return out
}

/** md5 of a function body with the pre-check's normalisation: CR removed, leading/trailing newlines trimmed. */
const bodyMd5 = (src: string) => createHash("md5").update(src.replace(/\r/g, "").replace(/^\n+|\n+$/g, "")).digest("hex")
/** The raw text between $fn$ and $fn$; of claim_momo_transaction in a migration file. */
function rawBody(sql: string): string {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_momo_transaction(")
  const a = sql.indexOf("$fn$", start) + 4
  return sql.slice(a, sql.indexOf("$fn$;", a))
}
const headerMd5 = () => migration().match(/-- must equal ([0-9a-f]{32})/)?.[1]

describe("0161 migration text", () => {
  it("is one transaction with lock and statement timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("seeds momo_first_claim_review = {\"value\": true} with ON CONFLICT DO NOTHING and a description", () => {
    const c = code(migration())
    expect(c).toMatch(/'momo_first_claim_review',\s*'\{"value": true\}'::jsonb,\s*'[^']{10,}'/)
    expect(c).toMatch(/ON CONFLICT \(key\) DO NOTHING/)
    expect(c).not.toMatch(/ON CONFLICT \(key\) DO UPDATE/i)
  })

  it("replaces only claim_momo_transaction, with the same signature, SECURITY DEFINER and empty search_path", () => {
    const c = code(migration())
    expect(c.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(c).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_momo_transaction\(\s*p_txid\s+text,\s*p_user\s+uuid,\s*p_session_id\s+uuid,\s*p_check_amount\s+boolean,\s*p_mode\s+text\s*\)\s*RETURNS text\s*LANGUAGE plpgsql\s*SECURITY DEFINER\s*SET search_path = ''/)
    expect(c).not.toMatch(/DROP FUNCTION/i)
    expect(c).not.toMatch(/\bGRANT\b/)
  })

  it("re-states the internal grants: nobody may execute it", () => {
    expect(code(migration())).toContain(
      "REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(text, uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated, service_role;",
    )
  })

  it("the body is 0160's except the first_claim gate on the setting", () => {
    expect(undo0161(fnBody(migration()))).toEqual(fnBody(read(BASE)))
  })

  it("the body comparison catches any extra line, including a second v_review assignment", () => {
    const base = fnBody(read(BASE))
    const next = fnBody(migration())
    const at = next.indexOf(GATE)
    const withExtraAssign = [...next.slice(0, at), "v_review := false;", ...next.slice(at)]
    expect(undo0161(withExtraAssign)).not.toEqual(base)
    const withExtraLine = [...next.slice(0, at), "PERFORM 1;", ...next.slice(at)]
    expect(undo0161(withExtraLine)).not.toEqual(base)
    expect(() => undo0161([...next, ASSIGN])).toThrow(/exactly one/)
    expect(() => undo0161(next.filter(l => l !== DECL))).toThrow(/exactly one/)
  })

  it("the header's body md5 pre-check constant equals the md5 of the committed 0160 body", () => {
    const want = headerMd5()
    expect(want).toMatch(/^[0-9a-f]{32}$/)
    expect(bodyMd5(rawBody(read(BASE)))).toBe(want)
    // the CRLF form of the same file hashes the same after the pre-check's normalisation
    expect(bodyMd5(rawBody(read(BASE).replace(/\n/g, "\r\n")))).toBe(want)
    expect(migration()).toContain("SELECT md5(btrim(replace(prosrc, E'\\r', ''), E'\\n')) FROM pg_proc")
    expect(migration()).toContain("SELECT pg_get_userbyid(proowner) FROM pg_proc")
  })

  it("reads the setting after the wallet lock (the per-user checks stay under it)", () => {
    const next = fnBody(migration()).join("\n")
    const lock = next.indexOf("FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE")
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(next.indexOf("momo_first_claim_review"))
    expect(lock).toBeLessThan(next.indexOf("'first_claim'"))
  })

  it("documents its pre-checks", () => {
    const m = migration()
    expect(m).toMatch(/PRE-CHECKS/)
    expect(m).toContain("pg_get_function_identity_arguments")
    expect(m).toMatch(/key = 'momo_first_claim_review'.*-- 0/)
  })
})

describe("0161 run string (migration + self-test)", () => {
  it("has no COMMIT and no bare END; statement, and ends with the always-raising DO block", () => {
    const s = code(runString())
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0161[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("the builder refuses a second COMMIT, a bare END; and a self-test that does not raise last", () => {
    const m = migration()
    const st = read(SELFTEST_FILE)
    expect(() => buildRunString(m.replace(/^BEGIN;/m, "BEGIN;\nCOMMIT;"), st)).toThrow(/could commit/)
    expect(() => buildRunString(m, st.replace(/^DO \$selftest\$;?/m, "$&\n--\nCOMMIT;"))).toThrow(/could commit/)
    expect(() => buildRunString(m.replace(/^BEGIN;/m, "BEGIN;\nEND;"), st)).toThrow(/could commit/)
    expect(() => buildRunString(m, st.replace(/RAISE EXCEPTION 'SELFTEST_OK[^']*';/, ""))).toThrow(/does not end by raising/)
  })

  it("self-test covers every scenario", () => {
    const st = read(SELFTEST_FILE)
    for (const label of ["setup", "setting_default", "fn_catalog", "fn_grants", "wallet_lock_first", "review_on_flags_first_claim",
                         "malformed_keeps_review", "off_above_threshold_still_flagged", "off_first_claim_credited"]) {
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
  INSERT INTO auth.users VALUES ('5f0c1a9e-0161-4161-8161-000000000001');
  INSERT INTO public.users VALUES ('5f0c1a9e-0161-4161-8161-000000000001', 'admin');
  INSERT INTO public.wallets (user_id, balance) VALUES ('5f0c1a9e-0161-4161-8161-000000000001', 100);
`
const ADMIN = "5f0c1a9e-0161-4161-8161-000000000001"

describe.skipIf(!PGliteCtor)("0161 in PGlite (on top of 0160)", () => {
  let db: any
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n)
  const prosrc = async () => (await one("SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure", [FN_SIG])).s as string

  let seq = 0
  const txid = () => String(30000000 + ++seq)
  let codeSeq = 0
  const nextCode = () => {
    const n = codeSeq++
    const d = (k: number) => String(2 + (Math.floor(n / 8 ** k) % 8))
    return "TSU" + d(3) + d(2) + d(1) + d(0)
  }
  const mkUser = async (balance = 0) => {
    const id = crypto.randomUUID()
    await db.query("INSERT INTO auth.users VALUES ($1)", [id])
    await db.query("INSERT INTO public.users VALUES ($1, 'user')", [id])
    await db.query("INSERT INTO public.wallets (user_id, balance) VALUES ($1, $2)", [id, balance])
    return id
  }
  const season = (user: string, net = 1) =>
    db.query(`INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount, net_amount, fee, claimed_by, claimed_at)
              VALUES ($1, 'sms', 'claimed', $2, $2, 0, $3, now())`, [txid(), net, user])
  const momo = async (amount: number) => {
    const id = txid()
    await db.query(`INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount, received_at)
                    VALUES ($1, 'sms', 'pending', $2, now() - interval '5 minutes')`, [id, amount])
    return id
  }
  const session = async (user: string, amount: number) => {
    const code = nextCode()
    const r = await one(`INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, created_at, expires_at)
                         VALUES ($1, $2, $3, 0, $3, now() - interval '10 minutes', now() + interval '1 hour') RETURNING id`, [user, code, amount])
    return { id: r.id as string, code }
  }
  const manual = async (user: string, id: string, sessionId: string) =>
    (await one("SELECT public.claim_momo_via_session($1, $2, $3) AS r", [user, id, sessionId])).r as string
  const webhook = async (code: string, id: string) =>
    (await one("SELECT public.claim_via_wallet_topup_session($1, $2) AS r", [code, id])).r as string
  const row = (id: string) => one("SELECT * FROM public.momo_transactions WHERE transaction_id = $1", [id])
  const sess = (id: string) => one("SELECT * FROM public.wallet_topup_sessions WHERE id = $1", [id])
  const ledger = (id: string) => db.query("SELECT * FROM public.transactions WHERE reference_id = $1", ["MOMO-" + id]).then((r: any) => r.rows)
  const balance = async (user: string) => Number((await one("SELECT balance AS b FROM public.wallets WHERE user_id = $1", [user])).b)
  const setRaw = (key: string, json: string) =>
    db.query(`INSERT INTO public.admin_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, json])
  const review = (json: string | null) =>
    json === null ? db.query("DELETE FROM public.admin_settings WHERE key = 'momo_first_claim_review'") : setRaw("momo_first_claim_review", json)

  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(FIXTURES)
    await db.exec(read(BASE))
  }, 60_000)

  it("the pre-check md5 run in SQL on applied 0160 matches the header constant", async () => {
    const r = await one("SELECT md5(btrim(replace(prosrc, E'\\r', ''), E'\\n')) AS h FROM pg_proc WHERE oid = $1::regprocedure", [FN_SIG])
    expect(r.h).toBe(headerMd5())
  })

  it("the self-rolling-back run string reports SELFTEST_OK and leaves 0160 exactly as it was", async () => {
    const before = await prosrc()
    try {
      await expect(db.exec(runString())).rejects.toThrow(/SELFTEST_OK 0161/)
    } finally {
      await db.exec("ROLLBACK")
    }
    expect(await prosrc()).toBe(before)
    expect(before).not.toContain("momo_first_claim_review")
    expect(await count("SELECT count(*) AS n FROM public.admin_settings WHERE key = 'momo_first_claim_review'")).toBe(0)
    expect(await count("SELECT count(*) AS n FROM public.momo_transactions")).toBe(0)
    expect(await count("SELECT count(*) AS n FROM public.transactions")).toBe(0)
    expect(await balance(ADMIN)).toBe(100)
  })

  describe("after apply (twice: idempotent)", () => {
    beforeAll(async () => {
      await db.exec(migration())
      await db.exec(migration())
    })

    it("seeds the setting once, ON (true), with a description", async () => {
      const r = await one("SELECT value AS v, description AS d FROM public.admin_settings WHERE key = 'momo_first_claim_review'")
      expect(r.v).toEqual({ value: true })
      expect(String(r.d ?? "").length).toBeGreaterThan(10)
      expect(await count("SELECT count(*) AS n FROM public.admin_settings WHERE key = 'momo_first_claim_review'")).toBe(1)
    })

    it("re-applying does not overwrite an admin's choice", async () => {
      await review('{"value": false}')
      await db.exec(migration())
      expect((await one("SELECT value AS v FROM public.admin_settings WHERE key = 'momo_first_claim_review'")).v).toEqual({ value: false })
      await review('{"value": true}')
    })

    it("keeps the signature, SECURITY DEFINER, empty search_path, one overload, and nobody may execute it", async () => {
      const r = await one(`SELECT pg_get_function_identity_arguments(p.oid) AS a, pg_get_function_result(p.oid) AS res, p.prosecdef AS d, p.proconfig AS c
                           FROM pg_proc p WHERE p.oid = $1::regprocedure`, [FN_SIG])
      expect(r).toEqual({ a: "p_txid text, p_user uuid, p_session_id uuid, p_check_amount boolean, p_mode text", res: "text", d: true, c: ['search_path=""'] })
      expect(await count("SELECT count(*) AS n FROM pg_proc WHERE proname = 'claim_momo_transaction'")).toBe(1)
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, FN_SIG])).ok).toBe(false)
      }
      expect(await count("SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0", [FN_SIG])).toBe(0)
      for (const f of ["public.claim_via_wallet_topup_session(text,text)", "public.claim_momo_via_session(uuid,text,uuid)"]) {
        expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok).toBe(true)
        expect((await one("SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS ok", [f])).ok).toBe(false)
      }
    })

    it("review ON (default): a first claim goes to review with first_claim", async () => {
      await review('{"value": true}')
      const u = await mkUser(5)
      const s = await session(u, 20)
      const id = await momo(20)
      expect(await manual(u, id, s.id)).toBe("under_review")
      const r = await row(id)
      expect(r).toMatchObject({ status: "flagged", flag_reasons: ["first_claim"], session_id: s.id, claimed_by: null })
      expect(await balance(u)).toBe(5)
      expect((await sess(s.id)).status).toBe("pending")
    })

    it.each([
      ["a string \"false\"", '{"value": "false"}'],
      ["zero", '{"value": 0}'],
      ["null", '{"value": null}'],
      ["no value key", "{}"],
      ["a bare false", "false"],
      ["an array", "[false]"],
      ["a missing row", null],
    ])("anything but exact JSON false keeps review on: %s", async (_label, json) => {
      await review(json)
      const u = await mkUser()
      const s = await session(u, 20)
      const id = await momo(20)
      expect(await webhook(s.code, id)).toBe("under_review")
      expect((await row(id)).flag_reasons).toEqual(["first_claim"])
      await review('{"value": true}')
    })

    describe("review OFF ({\"value\": false})", () => {
      beforeAll(async () => {
        await review('{"value": false}')
      })

      it("a first claim is credited: wallet +net, one ledger row MOMO-<txid>, row and session claimed", async () => {
        const u = await mkUser(5)
        const s = await session(u, 20)
        const id = await momo(20)
        expect(await manual(u, id, s.id)).toBe("credited")
        expect(await balance(u)).toBe(25)
        const l = await ledger(id)
        expect(l).toHaveLength(1)
        expect(l[0]).toMatchObject({ user_id: u, type: "credit", source: "momo_claim", status: "completed" })
        expect(Number(l[0].amount)).toBe(20)
        expect(await row(id)).toMatchObject({ status: "claimed", claimed_by: u, session_id: s.id })
        expect(await sess(s.id)).toMatchObject({ status: "claimed", claimed_transaction_id: id })
      })

      it("the webhook also credits a first claim", async () => {
        const u = await mkUser()
        const s = await session(u, 15)
        const id = await momo(15)
        expect(await webhook(s.code, id)).toBe("credited")
        expect(await balance(u)).toBe(15)
      })

      it("an above-threshold first claim is still flagged, with above_review_threshold only", async () => {
        const u = await mkUser()
        const s = await session(u, 500.01)
        const id = await momo(500.01)
        expect(await manual(u, id, s.id)).toBe("under_review")
        expect(await row(id)).toMatchObject({ status: "flagged", flag_reasons: ["above_review_threshold"] })
        expect(await balance(u)).toBe(0)
      })

      it("the daily cap still flags", async () => {
        const u = await mkUser()
        await season(u, 2995)
        const s = await session(u, 10)
        const id = await momo(10)
        expect(await manual(u, id, s.id)).toBe("under_review")
        expect((await row(id)).flag_reasons).toEqual(["daily_cap"])
      })

      it("a webhook amount mismatch still flags", async () => {
        const u = await mkUser()
        const s = await session(u, 10)
        const id = await momo(11)
        expect(await webhook(s.code, id)).toBe("under_review")
        expect((await row(id)).flag_reasons).toEqual(["amount_mismatch"])
      })

      it("too_many_attempts still flags a txid others keep trying", async () => {
        const u = await mkUser()
        const id = await momo(10)
        await db.query("INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) SELECT gen_random_uuid(), $1, 'not_matched' FROM generate_series(1, 4)", [id])
        const s = await session(u, 12)
        expect(await manual(u, id, s.id)).toBe("not_matched")
        expect(await row(id)).toMatchObject({ status: "flagged", flag_reasons: ["too_many_attempts"] })
      })
    })
  })
})
