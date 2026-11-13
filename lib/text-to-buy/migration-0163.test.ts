// lib/text-to-buy/migration-0163.test.ts
// migrations/0163_text_to_buy.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0163_text_to_buy.sql"
const SELFTEST_FILE = "0163_text_to_buy.selftest.sql"
const migration = () => read(FILE)

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

/** The migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function buildRunString(migrationSql: string, selftestSql: string): string {
  const lines = migrationSql.split("\n")
  const commitAt = lines.map((l) => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0163: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = selftestSql.split("\n")
  const doAt = st.findIndex((l) => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0163: run string could commit")
  if (!/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;\s*$/.test(c)) throw new Error("0163: run string does not end by raising")
  return run
}

describe("0163 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("seeds only with ON CONFLICT DO NOTHING", () => {
    const c = code(migration())
    expect(c).toMatch(/ON CONFLICT \(key\) DO NOTHING/)
    expect(c).not.toMatch(/ON CONFLICT \(key\) DO UPDATE/i)
  })

  it("the run string has no COMMIT and no bare END; and ends by raising", () => {
    const s = code(buildRunString(migration(), read(SELFTEST_FILE)))
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0163[^']*';\s*END\s*\$selftest\$;$/)
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
`
const TABLES = ["ttb_messages", "ttb_conversations", "ttb_orders", "ttb_blocked", "ttb_heartbeat"]
const FUNCS = [
  "public.ttb_counts(text,text,timestamptz)",
  "public.ttb_global_prompts(timestamptz)",
  "public.ttb_overview(timestamptz)",
  "public.ttb_purge(timestamptz)",
]
const SENDER = "0200000101"
const OTHER = "0200000102"

describe.skipIf(!PGliteCtor)("0163 in PGlite", () => {
  let db: any
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n)
  const fails = async (sql: string, params: unknown[] = []) => {
    // a failed statement inside PGlite's implicit transaction needs no cleanup: each query is its own transaction
    await expect(db.query(sql, params)).rejects.toThrow()
  }
  const msg = (line: string, sender: string, dir: string, extra: Record<string, unknown> = {}) =>
    db.query(
      `INSERT INTO public.ttb_messages (line, sender, direction, body, read_by, outcome, created_at)
       VALUES ($1, $2, $3, 'x', $4, $5, COALESCE($6::timestamptz, now()))`,
      [line, sender, dir, extra.readBy ?? null, extra.outcome ?? null, extra.at ?? null],
    )
  const order = (line: string, sender: string, extra: Record<string, unknown> = {}) =>
    db.query(
      `INSERT INTO public.ttb_orders (line, sender, order_id, state, size, recipient, gift, amount, notices, created_at, paid_at, delivered_at)
       VALUES ($1, $2, gen_random_uuid(), $3, '1GB', '0200000150', false, 5, $4::text[], COALESCE($5::timestamptz, now()), $6, $7)`,
      [line, sender, extra.state ?? "closed", extra.notices ?? [], extra.at ?? null, extra.paidAt ?? null, extra.deliveredAt ?? null],
    )

  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(FIXTURES)
  }, 60_000)

  it("applies twice without error", async () => {
    await db.exec(migration())
    await db.exec(migration())
    for (const t of TABLES) expect(await count("SELECT count(*) AS n FROM pg_class WHERE oid = to_regclass($1)", ["public." + t])).toBe(1)
  })

  it("seeds the 12 settings once, off by default, shaped {value}", async () => {
    const rows = await db.query("SELECT key, value, description FROM public.admin_settings WHERE key LIKE 'ttb\\_%' ORDER BY key")
    const got = Object.fromEntries(rows.rows.map((r: any) => [r.key, r.value]))
    expect(got).toEqual({
      ttb_main_enabled: { value: false },
      ttb_main_number: { value: "" },
      ttb_reply_sender_id: { value: "" },
      ttb_ai_enabled: { value: true },
      ttb_stale_minutes: { value: 10 },
      ttb_prompts_per_hour: { value: 3 },
      ttb_replies_per_hour: { value: 6 },
      ttb_ai_reads_per_hour: { value: 10 },
      ttb_global_prompts_per_minute: { value: 30 },
      ttb_prompt_window_minutes: { value: 5 },
      ttb_quiet_alert_minutes: { value: 60 },
      ttb_retention_days: { value: 30 },
    })
    for (const r of rows.rows) expect(String(r.description ?? "").length).toBeGreaterThan(10)
  })

  it("re-applying never overwrites an admin's choice", async () => {
    await db.query("UPDATE public.admin_settings SET value = '{\"value\": true}'::jsonb WHERE key = 'ttb_main_enabled'")
    await db.exec(migration())
    expect((await one("SELECT value AS v FROM public.admin_settings WHERE key = 'ttb_main_enabled'")).v).toEqual({ value: true })
    await db.query("UPDATE public.admin_settings SET value = '{\"value\": false}'::jsonb WHERE key = 'ttb_main_enabled'")
  })

  it("allows one awaiting_payment per (line, sender) but any number of closed", async () => {
    await order("main", SENDER, { state: "awaiting_payment" })
    await fails(
      `INSERT INTO public.ttb_orders (line, sender, order_id, state, size, recipient, gift, amount)
       VALUES ('main', $1, gen_random_uuid(), 'awaiting_payment', '1GB', '0200000150', false, 5)`,
      [SENDER],
    )
    await order("main", SENDER, { state: "closed" })
    await order("main", SENDER, { state: "closed" })
    await order("shop", SENDER, { state: "awaiting_payment" }) // another line is independent
    await order("main", OTHER, { state: "awaiting_payment" }) // another sender is independent
  })

  it("order_id is unique and not a foreign key", async () => {
    const id = "6f0c1a9e-0163-4163-8163-000000000001"
    await db.query(
      `INSERT INTO public.ttb_orders (line, sender, order_id, state, size, recipient, gift, amount) VALUES ('main', '0200000103', $1, 'closed', '1GB', 'r', false, 1)`,
      [id],
    )
    await fails(
      `INSERT INTO public.ttb_orders (line, sender, order_id, state, size, recipient, gift, amount) VALUES ('main', '0200000104', $1, 'closed', '1GB', 'r', false, 1)`,
      [id],
    )
    expect(await count("SELECT count(*) AS n FROM pg_constraint WHERE conrelid = 'public.ttb_orders'::regclass AND contype = 'f'")).toBe(0)
  })

  it("has the constraint names store.ts matches on (so the string matching cannot rot silently)", async () => {
    for (const name of ["ttb_orders_one_open", "ttb_orders_order_id_key"]) {
      expect(await count("SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [name])).toBe(1)
    }
    // and a real violation names them in the error message
    const id = "6f0c1a9e-0163-4163-8163-0000000000b1"
    const ins = (sender: string, orderId: string) =>
      db.query(
        `INSERT INTO public.ttb_orders (line, sender, order_id, size, recipient, gift, amount) VALUES ('shop', $1, $2, '1GB', 'r', false, 1)`,
        [sender, orderId],
      )
    await ins("0200000130", id)
    await expect(ins("0200000131", id)).rejects.toThrow(/ttb_orders_order_id_key/)
    await expect(ins("0200000130", "6f0c1a9e-0163-4163-8163-0000000000b2")).rejects.toThrow(/ttb_orders_one_open/)
  })

  it("refuses a line outside the allowed set on orders, conversations and heartbeat", async () => {
    await fails(
      `INSERT INTO public.ttb_orders (line, sender, order_id, state, size, recipient, gift, amount) VALUES ('typo', $1, gen_random_uuid(), 'closed', '1GB', 'r', false, 1)`,
      [SENDER],
    )
    await fails("INSERT INTO public.ttb_conversations (line, sender, expires_at) VALUES ('typo', $1, now())", [SENDER])
    await fails("INSERT INTO public.ttb_heartbeat (line, last_seen_at) VALUES ('typo', now())")
    for (const line of ["main", "shop", "purge", "quiet_alert"]) {
      await db.query("INSERT INTO public.ttb_heartbeat (line, last_seen_at) VALUES ($1, now())", [line])
    }
  })

  it("every ttb_ function pins search_path to public, pg_temp", async () => {
    const r = await db.query("SELECT proname, proconfig FROM pg_proc WHERE proname LIKE 'ttb\\_%'")
    expect(r.rows).toHaveLength(FUNCS.length)
    for (const f of r.rows) expect(f.proconfig).toEqual(["search_path=public, pg_temp"])
  })

  it("rejects a bad line, direction, state or reader", async () => {
    await fails("INSERT INTO public.ttb_messages (line, sender, direction, body) VALUES ('web', $1, 'in', 'x')", [SENDER])
    await fails("INSERT INTO public.ttb_messages (line, sender, direction, body) VALUES ('main', $1, 'sideways', 'x')", [SENDER])
    await fails("INSERT INTO public.ttb_messages (line, sender, direction, body, read_by) VALUES ('main', $1, 'in', 'x', 'human')", [SENDER])
    await fails(
      `INSERT INTO public.ttb_orders (line, sender, order_id, state, size, recipient, gift, amount) VALUES ('main', $1, gen_random_uuid(), 'bogus', '1GB', 'r', false, 1)`,
      [SENDER],
    )
  })

  it("ttb_messages.claimed_at exists, is nullable, and a guarded claim succeeds only once per lease", async () => {
    const col = await one(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ttb_messages' AND column_name = 'claimed_at'",
    )
    expect(col).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" })
    const id = (await one("INSERT INTO public.ttb_messages (line, sender, direction, body) VALUES ('main', $1, 'in', 'claim me') RETURNING id", [SENDER])).id
    const claim = `UPDATE public.ttb_messages SET claimed_at = now()
       WHERE id = $1 AND outcome IS NULL AND (claimed_at IS NULL OR claimed_at < now() - interval '60 seconds') RETURNING id`
    expect((await db.query(claim, [id])).rows).toHaveLength(1)
    expect((await db.query(claim, [id])).rows).toHaveLength(0) // second claim inside the lease
    await db.query("UPDATE public.ttb_messages SET claimed_at = now() - interval '2 minutes' WHERE id = $1", [id])
    expect((await db.query(claim, [id])).rows).toHaveLength(1) // lease expired
    await db.query("UPDATE public.ttb_messages SET outcome = 'prompted', claimed_at = NULL WHERE id = $1", [id])
    expect((await db.query(claim, [id])).rows).toHaveLength(0) // processed rows are never claimed
  })

  it("re-applying the migration on a table that predates claimed_at adds the column", async () => {
    await db.exec("ALTER TABLE public.ttb_messages DROP COLUMN claimed_at")
    await db.exec(migration())
    expect(await count("SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'ttb_messages' AND column_name = 'claimed_at'")).toBe(1)
  })

  it("a duplicate dedupe_key fails, but many NULL keys are fine (outbound rows)", async () => {
    await db.query("INSERT INTO public.ttb_messages (line, sender, direction, body, dedupe_key) VALUES ('main', $1, 'in', 'x', 'k1')", [SENDER])
    await fails("INSERT INTO public.ttb_messages (line, sender, direction, body, dedupe_key) VALUES ('main', $1, 'in', 'x', 'k1')", [SENDER])
    await msg("main", SENDER, "out")
    await msg("main", SENDER, "out")
  })

  describe("functions", () => {
    // Far-future dates: rows from the tests above are created now(), so they fall before `since` and do not disturb the counts.
    const since = "2089-01-10T00:00:00Z"
    const old = "2089-01-01T00:00:00Z"
    const fresh = "2089-01-15T00:00:00Z"
    const S = "0200000110" // used only in this block
    const T = "0200000111"

    beforeAll(async () => {
      await msg("main", S, "in", { readBy: "ai", at: fresh })
      await msg("main", S, "in", { readBy: "ai", outcome: "not_order", at: fresh })
      await msg("main", S, "in", { readBy: "rules", outcome: "prompted", at: fresh })
      await msg("main", S, "in", { readBy: "ai", at: old }) // before since
      await msg("main", S, "out", { at: fresh })
      await msg("main", S, "out", { at: fresh })
      await msg("main", S, "out", { at: old }) // before since
      await msg("shop", S, "in", { readBy: "ai", at: fresh }) // another line
      await msg("main", T, "in", { readBy: "ai", at: fresh }) // another sender
      await order("main", S, { state: "closed", notices: ["unpaid"], at: fresh }) // counts
      await order("main", S, { state: "closed", notices: ["delivered"], at: fresh }) // not unpaid
      await order("main", S, { state: "closed", notices: ["unpaid"], at: old }) // before since
      await order("main", T, { state: "closed", notices: ["unpaid"], at: fresh }) // another sender
    }, 30_000)

    it("ttb_counts counts only rows since p_since (awaiting_payment or an 'unpaid' notice)", async () => {
      await order("main", S, { state: "awaiting_payment", at: fresh })
      const r = await one("SELECT * FROM public.ttb_counts('main', $1, $2::timestamptz)", [S, since])
      expect(r).toEqual({ prompts_unpaid: 2, replies: 2, ai_reads: 2, not_understood: 1 })
      await db.query("UPDATE public.ttb_orders SET state = 'closed' WHERE sender = $1 AND state = 'awaiting_payment'", [S])
    })

    it("ttb_global_prompts counts every prompt on every line since p_since", async () => {
      const base = await count("SELECT count(*) AS n FROM public.ttb_orders WHERE created_at >= $1::timestamptz", [since])
      expect(Number((await one("SELECT public.ttb_global_prompts($1::timestamptz) AS n", [since])).n)).toBe(base)
      expect(Number((await one("SELECT public.ttb_global_prompts('2100-01-01'::timestamptz) AS n")).n)).toBe(0)
    })

    it("ttb_overview: one row per line with each column as documented", async () => {
      await order("shop", "0200000112", { state: "closed", at: fresh, paidAt: fresh, deliveredAt: fresh })
      await order("shop", "0200000113", { state: "paid", at: fresh, paidAt: fresh })
      await order("shop", "0200000114", { state: "closed", at: fresh })
      await msg("shop", "0200000112", "in", { readBy: "rules", at: fresh })
      const r = (await db.query("SELECT * FROM public.ttb_overview('2089-01-14T00:00:00Z'::timestamptz) ORDER BY line")).rows
      expect(r.map((x: any) => x.line)).toEqual(["main", "shop"])
      // main since 01-14: texts = S ai, S ai, S rules, T ai = 4; replies 2; prompts = S x3 (one closed by the counts test) + T x1 = 4, none paid
      expect(r[0]).toMatchObject({ texts: 4, prompts: 4, paid: 0, delivered: 0, replies: 2, ai_reads: 3, rule_reads: 1 })
      // shop since 01-14: texts = S ai + the rules read = 2; prompts 3 (2 paid, 1 delivered)
      expect(r[1]).toMatchObject({ texts: 2, prompts: 3, paid: 2, delivered: 1, replies: 0, ai_reads: 1, rule_reads: 1 })
    })

    it("ttb_overview returns both lines even when empty", async () => {
      const r = (await db.query("SELECT * FROM public.ttb_overview('2100-01-01'::timestamptz) ORDER BY line")).rows
      expect(r.map((x: any) => [x.line, x.texts, x.prompts, x.paid, x.delivered, x.replies, x.ai_reads, x.rule_reads])).toEqual([
        ["main", 0, 0, 0, 0, 0, 0, 0],
        ["shop", 0, 0, 0, 0, 0, 0, 0],
      ])
    })

    it("ttb_purge deletes old messages and expired conversations, never orders", async () => {
      await db.query(
        `INSERT INTO public.ttb_conversations (line, sender, expires_at) VALUES
           ('main', '0200000120', '2089-01-02T00:00:00Z'), ('main', '0200000121', '2100-01-01T00:00:00Z')`,
      )
      const orders = await count("SELECT count(*) AS n FROM public.ttb_orders")
      const oldMsgs = await count("SELECT count(*) AS n FROM public.ttb_messages WHERE created_at < $1::timestamptz", [since])
      const total = await count("SELECT count(*) AS n FROM public.ttb_messages")
      expect(oldMsgs).toBeGreaterThan(0)
      expect(Number((await one("SELECT public.ttb_purge($1::timestamptz) AS n", [since])).n)).toBe(oldMsgs + 1)
      expect(await count("SELECT count(*) AS n FROM public.ttb_messages")).toBe(total - oldMsgs)
      expect(await count("SELECT count(*) AS n FROM public.ttb_conversations WHERE sender = '0200000120'")).toBe(0)
      expect(await count("SELECT count(*) AS n FROM public.ttb_conversations WHERE sender = '0200000121'")).toBe(1)
      expect(await count("SELECT count(*) AS n FROM public.ttb_orders")).toBe(orders)
    })
  })

  describe("privileges", () => {
    it("anon and authenticated have no table privilege; service_role has no DELETE on messages or orders", async () => {
      for (const t of TABLES) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          for (const role of ["anon", "authenticated"]) {
            expect((await one("SELECT has_table_privilege($1, $2, $3) AS ok", [role, "public." + t, p])).ok).toBe(false)
          }
        }
        expect((await one("SELECT relrowsecurity AS r FROM pg_class WHERE oid = $1::regclass", ["public." + t])).r).toBe(true)
        expect(await count("SELECT count(*) AS n FROM pg_policies WHERE tablename = $1", [t])).toBe(0)
        expect((await one("SELECT has_table_privilege('service_role', $1, 'SELECT') AS ok", ["public." + t])).ok).toBe(true)
      }
      for (const t of ["ttb_messages", "ttb_orders"]) {
        expect((await one("SELECT has_table_privilege('service_role', $1, 'DELETE') AS ok", ["public." + t])).ok).toBe(false)
      }
    })

    it("anon, authenticated and PUBLIC cannot execute any ttb_ function; service_role can", async () => {
      expect(await count("SELECT count(*) AS n FROM pg_proc WHERE proname LIKE 'ttb\\_%'")).toBe(FUNCS.length)
      for (const f of FUNCS) {
        for (const role of ["anon", "authenticated"]) {
          expect((await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, f])).ok).toBe(false)
        }
        expect(await count("SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0", [f])).toBe(0)
        expect((await one("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [f])).ok).toBe(true)
        expect((await one("SELECT p.prosecdef AS d FROM pg_proc p WHERE p.oid = $1::regprocedure", [f])).d).toBe(true)
      }
    })
  })

  it("the self-rolling-back run string reports SELFTEST_OK on a fresh database and leaves nothing behind", async () => {
    const fresh = new PGliteCtor()
    await fresh.exec(ROLES)
    await fresh.exec(FIXTURES)
    await expect(fresh.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/SELFTEST_OK 0163/)
    await fresh.exec("ROLLBACK")
    expect((await fresh.query("SELECT to_regclass('public.ttb_messages') AS t")).rows[0].t).toBeNull()
    expect((await fresh.query("SELECT count(*)::int AS n FROM public.admin_settings")).rows[0].n).toBe(0)
  }, 60_000)
})

