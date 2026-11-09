// lib/standard-bundles/bot-special-migration.test.ts
// migrations/0158_bot_special_bundles.sql and its self-test. The static checks follow special-migration.test.ts and
// always run. The behaviour block runs the real SQL in PGlite (WASM Postgres).
//
// PGlite is not a dependency of this repo (reference-pglite-sql-tests): the block is SKIPPED, visibly, where the
// package cannot be resolved. To run it, unpack @electric-sql/pglite@0.2.17 into the gitignored node_modules/.
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

// CRLF -> LF: the repo checks migrations out with CRLF, and `--.*$` would not strip a comment ending in "\r".
const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const exists = (f: string) => { try { read(f); return true } catch { return false } }

const FILE = "0158_bot_special_bundles.sql"
const SELFTEST_FILE = "0158_bot_special_bundles.selftest.sql"
const migration = () => read(FILE)
const SIG = "public.create_bot_special_bundle_orders(text, text, uuid, text, integer, jsonb, numeric)"

/** SQL with `--` comments removed (comments mention the forbidden words on purpose). */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")

/** The function body between `AS $fn$` and the closing `$fn$;`. */
function rpcBody(): string {
  const m = migration().match(/CREATE OR REPLACE FUNCTION public\.create_bot_special_bundle_orders\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/)
  if (!m) throw new Error("0158: create_bot_special_bundle_orders body not found")
  return code(m[1])
}

/** House run string: migration minus ONLY its final COMMIT line, then the self-test from the column-0 DO line on. */
function runString(): string {
  const lines = migration().split("\n")
  const commitAt = lines.map(l => l.trim()).lastIndexOf("COMMIT;")
  if (commitAt < 0) throw new Error("0158: no COMMIT line")
  const head = lines.filter((_, i) => i !== commitAt).join("\n")
  const st = read(SELFTEST_FILE).split("\n")
  const doAt = st.findIndex(l => /^DO\b/.test(l))
  if (doAt < 0) throw new Error("selftest: no column-0 DO line")
  const run = head + "\n" + st.slice(doAt).join("\n")
  const c = code(run)
  // The 0130 incident lesson: this string is what goes to production, so the code that builds it refuses a bad one.
  if (/\bCOMMIT\b/i.test(c) || /^\s*END\s*;/im.test(c)) throw new Error("0158: run string could commit")
  return run
}

describe("0158 migration text", () => {
  it("is one transaction with lock and statement timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("widens the CHECK to dashboard and bots, keeps MTN, and requires a surface on a bots row", () => {
    const c = code(migration())
    expect(c).toMatch(/DROP CONSTRAINT IF EXISTS hubtel_data_orders_special_check/)
    expect(c).toMatch(/channel IN \('dashboard','bots'\) AND network = 'MTN'/)
    expect(c).toMatch(/channel <> 'bots' OR bot_surface IS NOT NULL/)
  })

  it("is SECURITY DEFINER with a pinned search_path, executable by service_role only", () => {
    const m = migration()
    const head = m.match(/CREATE OR REPLACE FUNCTION public\.create_bot_special_bundle_orders\(([\s\S]*?)AS \$fn\$/)
    expect(head).not.toBeNull()
    expect(head![1]).toMatch(/p_surface\s+text,\s*p_buyer\s+text,\s*p_shop\s+uuid,\s*p_group_key\s+text,\s*p_n\s+integer,\s*p_rows\s+jsonb,\s*p_total\s+numeric/)
    expect(head![1]).toMatch(/RETURNS jsonb/)
    expect(head![1]).toMatch(/SECURITY DEFINER/)
    expect(head![1]).toMatch(/SET search_path = public/)
    expect(m).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated;`)
    expect(m).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role;`)
    expect(code(m).match(/GRANT EXECUTE ON FUNCTION public\.create_bot_special_bundle_orders/g)).toHaveLength(1)
  })

  it("never reads or writes money tables, and never edits the dashboard RPC", () => {
    expect(rpcBody()).not.toMatch(/wallet|transactions|deduct_/i)
    expect(code(migration())).not.toMatch(/create_special_bundle_orders/)
  })

  it("checks for the group, then validates, then inserts, with the unique-index backstop around the inserts", () => {
    const b = rpcBody()
    const replay = b.search(/o\.idempotency_key = p_group_key \|\| ':1'/)
    const total = b.search(/v_sum <> p_total/)
    const insert = b.search(/INSERT INTO public\.hubtel_data_orders/)
    for (const at of [replay, total, insert]) expect(at).toBeGreaterThan(-1)
    expect(replay).toBeLessThan(total)
    expect(total).toBeLessThan(insert)
    expect(b).toMatch(/WHEN unique_violation THEN/)
    expect(b.match(/INSERT INTO public\.hubtel_data_orders/g)).toHaveLength(1)
  })

  it("never re-raises Postgres's own error, and checks the shop on both replay paths", () => {
    const b = rpcBody()
    expect(b).not.toMatch(/\bRAISE\s*;/)
    expect(b.match(/v_shop IS DISTINCT FROM p_shop/g)).toHaveLength(2)
  })

  it("prices with the fee exactly", () => {
    expect(rpcBody()).toMatch(/v_paid <> v_amount - COALESCE\(\(v_unit ->> 'cashback_amount'\)::numeric, 0\) \+ v_fee/)
  })

  it("states the pre-checks: the CHECK as 0141 left it, and that the new name is free", () => {
    const m = migration()
    expect(m).toContain("channel = 'dashboard'::text")
    expect(m).toMatch(/pg_proc WHERE proname = 'create_bot_special_bundle_orders'[^\n]*-- 0/)
    expect(m).toContain("uq_hubtel_data_orders_bots_idem")
  })
})

describe("0158 run string (migration + self-test)", () => {
  it("has no COMMIT and no bare END; statement, and ends with the always-raising DO block", () => {
    const s = code(runString())
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s).not.toMatch(/^\s*END\s*;/im)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK[^']*';\s*END\s*\$selftest\$;$/)
  })

  it("self-test covers replay, every refusal, the CHECK and the grants", () => {
    expect(exists(SELFTEST_FILE)).toBe(true)
    const st = read(SELFTEST_FILE)
    for (const label of ["happy", "main_context", "replay", "replay_other_shop", "fee_paid_wrong", "fee_negative", "other_buyer", "no_partial_group", "key_used_by_normal_order", "bad_total", "rows_differ", "not_mtn",
                         "paid_not_face_minus_cashback", "bad_surface", "share_without_shop", "dashboard_special", "storefront_special",
                         "bots_without_surface", "deny_anon", "deny_authenticated"]) {
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

// Real 0118 and 0141 around these deltas, copied from 0119, 0120 and 0123 (those files also touch tables this does not need).
const ROLES = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  -- Supabase's default, so the REVOKE is really tested.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
`
const DELTAS = `
  ALTER TABLE public.hubtel_data_orders
    ADD COLUMN IF NOT EXISTS cashback_amount     numeric(12,2),
    ADD COLUMN IF NOT EXISTS shop_share_amount   numeric(12,2),
    ADD COLUMN IF NOT EXISTS cashback_rate       numeric(6,3),
    ADD COLUMN IF NOT EXISTS cashback_share      numeric(6,2),
    ADD COLUMN IF NOT EXISTS cashback_provider   text,
    ADD COLUMN IF NOT EXISTS expected_commission numeric(12,4),
    ADD COLUMN IF NOT EXISTS paid_amount         numeric(12,2) CHECK (paid_amount IS NULL OR paid_amount > 0);
  ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT IF EXISTS hubtel_data_orders_channel_check;
  ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_channel_check
    CHECK (channel IN ('dashboard','storefront','api','bots'));
  ALTER TABLE public.hubtel_data_orders ALTER COLUMN user_id DROP NOT NULL;
  ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_dashboard_user_check
    CHECK (channel <> 'dashboard' OR user_id IS NOT NULL);
  ALTER TABLE public.hubtel_data_orders
    ADD COLUMN IF NOT EXISTS shop_id            uuid,
    ADD COLUMN IF NOT EXISTS buyer_name         text,
    ADD COLUMN IF NOT EXISTS buyer_email        text,
    ADD COLUMN IF NOT EXISTS buyer_phone        text,
    ADD COLUMN IF NOT EXISTS payment_fee_amount numeric(12,2),
    ADD COLUMN IF NOT EXISTS payment_reference  text,
    ADD COLUMN IF NOT EXISTS refund_method      text,
    ADD COLUMN IF NOT EXISTS paid_at            timestamptz;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_hubtel_data_orders_storefront_idem
    ON public.hubtel_data_orders (shop_id, idempotency_key) WHERE channel = 'storefront';
  ALTER TABLE public.hubtel_data_orders ADD COLUMN IF NOT EXISTS bot_surface text;
  ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_bot_surface_check
    CHECK (bot_surface IS NULL OR bot_surface IN ('hubtel_ussd','ussd','ussd_shop','whatsapp','whatsapp_shop'));
  ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_bot_surface_required
    CHECK (channel <> 'bots' OR bot_surface IS NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_hubtel_data_orders_bots_idem
    ON public.hubtel_data_orders (bot_surface, buyer_phone, idempotency_key) WHERE channel = 'bots';
`
const MONEY = `
  CREATE TABLE public.wallets (user_id uuid PRIMARY KEY, balance numeric NOT NULL, total_spent numeric NOT NULL DEFAULT 0);
  CREATE TABLE public.transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric, reference_id text);
  INSERT INTO public.wallets VALUES (gen_random_uuid(), 100, 5);
  INSERT INTO public.transactions (user_id, amount) SELECT user_id, 5 FROM public.wallets;
`

const BUYER = "233249990158"
const BENEFICIARY = "233249990159"
const SHOP = "5f0c1a9e-0158-4158-8158-000000000158"
const UNIT = {
  network: "MTN", service_key: "data_mtn", beneficiary_phone: BENEFICIARY,
  bundle_value: "selftest-0158", bundle_display: "406.89MB", bundle_category: "Non Expiry",
  amount: 3, paid_amount: 2.95, cashback_amount: 0.05, shop_share_amount: 0.02,
  cashback_rate: 2.5, cashback_share: 50, cashback_provider: "hubtel", expected_commission: 0.075,
}
const rows = (n: number, unit: object = UNIT) => Array.from({ length: n }, () => unit)
let seq = 0
const newKey = () => `selftest-key-${++seq}`

describe.skipIf(!PGliteCtor)("0158 in PGlite", () => {
  let db: any
  const call = async (a: { surface?: unknown; buyer?: unknown; shop?: unknown; key?: unknown; n?: unknown; rows?: unknown; total?: unknown }) => {
    const res = await db.query(
      "SELECT public.create_bot_special_bundle_orders($1::text, $2::text, $3::uuid, $4::text, $5::integer, $6::jsonb, $7::numeric) AS r",
      ["surface" in a ? a.surface : "hubtel_ussd", "buyer" in a ? a.buyer : BUYER, "shop" in a ? a.shop : SHOP, a.key ?? newKey(), a.n ?? 3, a.rows ?? rows(3), "total" in a ? a.total : "8.85"],
    )
    return res.rows[0].r
  }
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const orderCount = async () => Number((await one("SELECT count(*) AS n FROM public.hubtel_data_orders")).n)
  const moneyState = async () => JSON.stringify([
    await one("SELECT count(*), sum(balance), sum(total_spent) FROM public.wallets"),
    await one("SELECT count(*), sum(amount) FROM public.transactions"),
  ])
  const insertRow = (o: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      reference_code: `SB-T${++seq}`, network: "MTN", service_key: "data_mtn", beneficiary_phone: BENEFICIARY,
      bundle_value: "selftest-0158", bundle_display: "406.89MB", bundle_category: "Non Expiry", amount: 3,
      idempotency_key: `direct-${seq}`, special_group_id: "5f0c1a9e-0158-4158-8158-00000000a158", special_index: seq % 50 + 1, ...o,
    }
    const cols = Object.keys(row)
    return db.query(
      `INSERT INTO public.hubtel_data_orders (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
      Object.values(row),
    )
  }

  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(ROLES)
    await db.exec(read("0118_hubtel_data_orders.sql"))
    await db.exec(DELTAS)
    await db.exec(MONEY)
    await db.exec(read("0141_special_bundles.sql"))
  }, 60_000)

  it("the pre-check's CHECK text is what 0141 really leaves", async () => {
    const { def } = await one("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'hubtel_data_orders_special_check'")
    expect(migration()).toContain(def)
  })

  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const before = await orderCount()
    try {
      await expect(db.exec(runString())).rejects.toThrow(/SELFTEST_OK 0158/)
    } finally {
      await db.exec("ROLLBACK") // also on a failure, so it cannot hide the behaviour tests below
    }
    expect(Number((await one("SELECT count(*) AS n FROM pg_proc WHERE proname = 'create_bot_special_bundle_orders'")).n)).toBe(0)
    expect(await orderCount()).toBe(before)
  })

  describe("after apply", () => {
    beforeAll(async () => {
      await db.exec(migration())
      await db.exec(migration()) // idempotent
    })

    it("two identical calls create N rows once; the second is a replay with the same ids", async () => {
      const before = await orderCount()
      const key = newKey()
      const first = await call({ key })
      expect(first.replay).toBe(false)
      expect(first.order_ids).toHaveLength(3)
      const second = await call({ key })
      expect(second).toEqual({ ...first, replay: true })
      expect(await orderCount()).toBe(before + 3)
    })

    it("rows are unpaid bots children with surface, buyer and shop set, and no money moves", async () => {
      const money = await moneyState()
      const key = newKey()
      const r = await call({ key })
      const got = (await db.query("SELECT * FROM public.hubtel_data_orders WHERE special_group_id = $1 ORDER BY special_index", [r.group_id])).rows
      expect(got.map((o: any) => o.id)).toEqual(r.order_ids)
      expect(got.map((o: any) => o.special_index)).toEqual([1, 2, 3])
      expect(got.map((o: any) => o.idempotency_key)).toEqual([`${key}:1`, `${key}:2`, `${key}:3`])
      for (const o of got) {
        expect(o).toMatchObject({
          channel: "bots", user_id: null, status: "pending", payment_status: "unpaid",
          bot_surface: "hubtel_ussd", buyer_phone: BUYER, shop_id: SHOP, buyer_name: null, buyer_email: null,
          network: "MTN", service_key: "data_mtn", beneficiary_phone: BENEFICIARY, hubtel_client_reference: null, paid_at: null,
        })
        expect([o.amount, o.paid_amount, o.cashback_amount, o.shop_share_amount, o.payment_fee_amount].map(Number)).toEqual([3, 2.95, 0.05, 0.02, 0])
        expect(o.reference_code).toMatch(/^SB-[0-9A-F]{12}$/)
      }
      expect(await moneyState()).toBe(money)
    })

    it("main context: no shop, a zero or absent share is accepted", async () => {
      for (const unit of [{ ...UNIT, shop_share_amount: 0 }, { ...UNIT, shop_share_amount: null }]) {
        const r = await call({ shop: null, n: 1, rows: rows(1, unit), total: "2.95" })
        const o = await one("SELECT shop_id FROM public.hubtel_data_orders WHERE id = $1", [r.order_ids[0]])
        expect(o.shop_id).toBeNull()
      }
    })

    it("the same key from another buyer is a separate group", async () => {
      const key = newKey()
      const a = await call({ key })
      const b = await call({ key, buyer: "233249990160" })
      expect(b.replay).toBe(false)
      expect(b.group_id).not.toBe(a.group_id)
    })

    it("a key held by an ordinary bot order is refused, not handed back as a group", async () => {
      const key = newKey()
      await insertRow({ channel: "bots", bot_surface: "hubtel_ussd", buyer_phone: BUYER, idempotency_key: `${key}:1`, special_group_id: null, special_index: null })
      await expect(call({ key })).rejects.toThrow("BAD_INPUT")
    })

    it("a clash on a later child writes no part of the group, and the error carries no phone", async () => {
      const before = await orderCount()
      const key = newKey()
      await insertRow({ channel: "bots", bot_surface: "hubtel_ussd", buyer_phone: BUYER, idempotency_key: `${key}:2`, special_group_id: null, special_index: null })
      const err: any = await call({ key }).then(() => null, e => e)
      expect(err?.message).toBe("GROUP_CONFLICT")
      expect(err.code).toBe("23505")
      expect(JSON.stringify({ m: err.message, d: err.detail, h: err.hint })).not.toContain(BUYER)
      expect(await orderCount()).toBe(before + 1) // only the row this test inserted
    })

    it("a replay never crosses shops: another shop, or shop to main and back, is refused", async () => {
      const OTHER = "5f0c1a9e-0158-4158-8158-000000000159"
      const shopKey = newKey()
      const first = await call({ key: shopKey })
      const before = await orderCount()
      await expect(call({ key: shopKey, shop: OTHER })).rejects.toThrow("BAD_INPUT")
      await expect(call({ key: shopKey, shop: null })).rejects.toThrow("BAD_INPUT")
      const mainKey = newKey()
      const unit = { ...UNIT, shop_share_amount: 0 }
      await call({ key: mainKey, shop: null, n: 1, rows: rows(1, unit), total: "2.95" })
      await expect(call({ key: mainKey, shop: SHOP, n: 1, rows: rows(1, unit), total: "2.95" })).rejects.toThrow("BAD_INPUT")
      expect(await orderCount()).toBe(before + 1) // only the main-code group
      expect(await call({ key: shopKey })).toEqual({ ...first, replay: true }) // the right shop still replays
    })

    it("a rail fee is stored on every child and can lift paid above face", async () => {
      const unit = { ...UNIT, payment_fee_amount: 0.1, paid_amount: 3.05 }
      const r = await call({ n: 2, rows: rows(2, unit), total: "6.10" })
      const got = (await db.query("SELECT amount, paid_amount, payment_fee_amount FROM public.hubtel_data_orders WHERE special_group_id = $1", [r.group_id])).rows
      expect(got).toHaveLength(2)
      for (const o of got as any[]) expect([o.amount, o.paid_amount, o.payment_fee_amount].map(Number)).toEqual([3, 3.05, 0.1])
    })

    it("an absent or null fee is stored as 0", async () => {
      for (const unit of [UNIT, { ...UNIT, payment_fee_amount: null }]) {
        const r = await call({ n: 1, rows: rows(1, unit), total: "2.95" })
        const o = await one("SELECT payment_fee_amount AS f FROM public.hubtel_data_orders WHERE id = $1", [r.order_ids[0]])
        expect(Number(o.f)).toBe(0)
        expect(o.f).not.toBeNull()
      }
    })

    const REFUSALS: [string, Parameters<typeof call>[0]][] = [
      ["total above N x paid", { total: "8.86" }],
      ["total below N x paid", { total: "8.84" }],
      ["total at face", { total: "9.00" }],
      ["no total", { total: null }],
      ["rows that differ", { rows: [UNIT, UNIT, { ...UNIT, beneficiary_phone: "233249990161" }] }],
      ["a non-MTN unit", { rows: rows(3, { ...UNIT, network: "TELECEL", service_key: "data_telecel" }) }],
      ["a non-MTN service", { rows: rows(3, { ...UNIT, service_key: "data_at" }) }],
      ["paid above amount - cashback", { rows: rows(3, { ...UNIT, paid_amount: 2.96 }), total: "8.88" }],
      ["paid below amount - cashback", { rows: rows(3, { ...UNIT, paid_amount: 2.94 }), total: "8.82" }],
      ["surface ussd", { surface: "ussd" }],
      ["surface whatsapp", { surface: "whatsapp" }],
      ["surface in the wrong case", { surface: "HUBTEL_USSD" }],
      ["no surface", { surface: null }],
      ["a share with no shop", { shop: null }],
      ["a buyer not in 233 form", { buyer: "0249990158" }],
      ["a buyer with a trailing newline", { buyer: `${BUYER}\n` }],
      ["no buyer", { buyer: null }],
      ["a key with a colon", { key: "selftest:key:1" }],
      ["a short key", { key: "short" }],
      ["n of 0", { n: 0, rows: [], total: "0" }],
      ["n of 51", { n: 51, rows: rows(51), total: "150.45" }],
      ["n differs from the rows", { n: 2 }],
      ["a caller-set column", { rows: rows(3, { ...UNIT, status: "completed" }) }],
      ["a fee the paid amount does not include", { rows: rows(3, { ...UNIT, payment_fee_amount: 1 }) }],
      ["a paid amount off by a pesewa with a fee", { rows: rows(3, { ...UNIT, payment_fee_amount: 0.1, paid_amount: 3.04 }), total: "9.12" }],
      ["a negative fee", { rows: rows(3, { ...UNIT, payment_fee_amount: -0.1, paid_amount: 2.85 }), total: "8.55" }],
      ["a fee with 3 decimals", { rows: rows(3, { ...UNIT, payment_fee_amount: 0.105, paid_amount: 3.05 }), total: "9.15" }],
      ["a fee as text", { rows: rows(3, { ...UNIT, payment_fee_amount: "0.10", paid_amount: 3.05 }), total: "9.15" }],
      ["a negative share", { rows: rows(3, { ...UNIT, shop_share_amount: -0.01 }) }],
      ["a bad beneficiary", { rows: rows(3, { ...UNIT, beneficiary_phone: "0249990159" }) }],
    ]
    it.each(REFUSALS)("BAD_INPUT and nothing written: %s", async (_label, args) => {
      const before = await orderCount()
      await expect(call(args)).rejects.toThrow("BAD_INPUT")
      expect(await orderCount()).toBe(before)
    })

    it("the CHECK: a dashboard Special row still inserts", async () => {
      await expect(insertRow({ channel: "dashboard", user_id: SHOP })).resolves.toBeTruthy()
    })
    it.each([["storefront"], ["api"]])("the CHECK: a %s Special row is refused", async channel => {
      await expect(insertRow({ channel, shop_id: SHOP })).rejects.toThrow(/hubtel_data_orders_special_check/)
    })
    it("the CHECK: a bots Special row off MTN is refused", async () => {
      await expect(insertRow({ channel: "bots", bot_surface: "hubtel_ussd", buyer_phone: BUYER, network: "TELECEL" }))
        .rejects.toThrow(/hubtel_data_orders_special_check/)
    })
    it("the CHECK itself requires a surface on a bots row, without help from 0123's constraint", async () => {
      await db.exec("BEGIN; ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT hubtel_data_orders_bot_surface_required;")
      try {
        await expect(insertRow({ channel: "bots", buyer_phone: BUYER })).rejects.toThrow(/hubtel_data_orders_special_check/)
      } finally {
        await db.exec("ROLLBACK")
      }
    })

    it.each([["anon"], ["authenticated"]])("%s cannot execute the function", async role => {
      const before = await orderCount()
      await db.exec(`SET ROLE ${role}`)
      try {
        await expect(call({})).rejects.toThrow(/permission denied for function/)
      } finally {
        await db.exec("RESET ROLE")
      }
      expect(await orderCount()).toBe(before)
    })
    it("service_role can execute it, and PUBLIC cannot", async () => {
      await db.exec("SET ROLE service_role")
      try {
        expect((await call({})).replay).toBe(false)
      } finally {
        await db.exec("RESET ROLE")
      }
      const { n } = await one(`SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a
                                WHERE p.proname = 'create_bot_special_bundle_orders' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`)
      expect(Number(n)).toBe(0)
    })

    it("the dashboard RPC still has exactly one signature", async () => {
      const { n } = await one("SELECT count(*) AS n FROM pg_proc WHERE proname = 'create_special_bundle_orders'")
      expect(Number(n)).toBe(1)
    })
  })
})
