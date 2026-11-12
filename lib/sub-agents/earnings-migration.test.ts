// lib/sub-agents/earnings-migration.test.ts
// migrations/0162_sub_agent_earnings_include_ussd.sql: a parent shop's "Earnings from Sub-Agents" card and its profit
// history list used to read shop_orders (web storefront) only, so every sale a sub-agent made through its USSD shop
// code or WhatsApp bot (ussd_shop_orders) was paid to the parent but never shown. The behaviour block runs the real
// SQL in PGlite and is SKIPPED, visibly, where @electric-sql/pglite cannot be resolved (reference-pglite-sql-tests).
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const FILE = "0162_sub_agent_earnings_include_ussd.sql"
const migration = () => readFileSync(join(process.cwd(), "migrations", FILE), "utf8")

async function loadPGlite(): Promise<any> {
  try {
    const name = "@electric-sql/pglite" // a variable: nothing may resolve this at transform time
    return (await import(/* @vite-ignore */ name)).PGlite
  } catch {
    return null
  }
}
const PGliteCtor = await loadPGlite()

// Only the columns the two functions read, with prod's types (shop_orders.created_at has NO time zone, ussd's has one).
const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
  CREATE TABLE public.user_shops (id uuid PRIMARY KEY, parent_shop_id uuid, shop_name text);
  CREATE TABLE public.shop_orders (
    id uuid PRIMARY KEY, shop_id uuid, parent_shop_id uuid, reference_code varchar, network varchar,
    volume_gb numeric, total_price numeric, parent_profit_amount numeric, payment_status varchar,
    created_at timestamp without time zone);
  CREATE TABLE public.ussd_shop_orders (
    id uuid PRIMARY KEY, shop_id uuid, parent_shop_id uuid, paystack_reference varchar, network varchar,
    package_size varchar, amount numeric, parent_profit_amount numeric, payment_status varchar,
    created_at timestamp with time zone);
  -- The function this migration replaces, as it is live (web orders only); grants as locked by 20260615.
  CREATE FUNCTION public.get_sub_agent_earnings_stats(p_parent_shop_id uuid) RETURNS json
    LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT '{}'::json $$;
  REVOKE ALL ON FUNCTION public.get_sub_agent_earnings_stats(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.get_sub_agent_earnings_stats(uuid) TO service_role;
`

const P = "00000000-0000-0000-0000-0000000000a1" // parent
const OTHER = "00000000-0000-0000-0000-0000000000a2" // another parent
const S1 = "00000000-0000-0000-0000-0000000000b1" // sub-agent of P
const S2 = "00000000-0000-0000-0000-0000000000b2" // sub-agent of P
const S3 = "00000000-0000-0000-0000-0000000000b3" // sub-agent of OTHER
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`

const DATA = `
  INSERT INTO public.user_shops VALUES
    ('${P}', NULL, 'Parent'), ('${OTHER}', NULL, 'Other'),
    ('${S1}', '${P}', 'Sub One'), ('${S2}', '${P}', 'Sub Two'), ('${S3}', '${OTHER}', 'Sub Three');
  INSERT INTO public.shop_orders VALUES
    ('${id(1)}', '${S1}', '${P}', 'WEB-1', 'MTN', 1, 6.00, 1.50, 'completed', '2026-11-12 08:00:00'),
    ('${id(2)}', '${S1}', '${P}', 'WEB-2', 'MTN', 2, 11.00, 0.00, 'completed', '2026-11-12 08:30:00'),
    ('${id(3)}', '${S1}', '${P}', 'WEB-3', 'MTN', 3, 15.00, 2.00, 'expired', '2026-11-12 09:00:00'),
    ('${id(4)}', '${S3}', '${OTHER}', 'WEB-4', 'MTN', 1, 6.00, 9.00, 'completed', '2026-11-12 09:30:00');
  INSERT INTO public.ussd_shop_orders VALUES
    ('${id(11)}', '${S2}', '${P}', 'USSD-1', 'MTN', '2', 12.41, 2.21, 'completed', '2026-11-12 10:00:00+00'),
    ('${id(12)}', '${S2}', '${P}', 'USSD-2', 'AT', '3', 17.81, 2.51, 'completed', '2026-11-12 07:00:00+00'),
    ('${id(13)}', '${S1}', '${P}', 'USSD-3', 'MTN', '1', 5.00, 1.00, 'completed', '2026-11-12 08:15:00+00'),
    ('${id(14)}', '${S2}', '${P}', 'USSD-4', 'MTN', '2', 12.41, 2.21, 'pending', '2026-11-12 10:30:00+00'),
    ('${id(15)}', '${S2}', '${P}', 'USSD-5', 'MTN', '2', 12.41, 2.21, 'failed', '2026-11-12 10:40:00+00'),
    ('${id(16)}', '${S3}', '${OTHER}', 'USSD-6', 'MTN', '2', 12.41, 7.00, 'completed', '2026-11-12 11:00:00+00');
`

describe("0162 file", () => {
  it("runs in one transaction and creates the history function", () => {
    const sql = migration()
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/^COMMIT;/m)
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.get_sub_agent_earnings_stats(p_parent_shop_id uuid)")
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.get_sub_agent_profit_history(")
  })
})

describe.skipIf(!PGliteCtor)("0162 in PGlite", () => {
  let db: any
  const one = async (q: string) => (await db.query(q)).rows[0]

  beforeAll(async () => {
    db = new PGliteCtor()
    await db.exec(SCHEMA)
    await db.exec(DATA)
    await db.exec(migration())
    await db.exec(migration()) // idempotent
  })

  it("stats: total earnings and order count include USSD/WhatsApp sales", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_earnings_stats('${P}') AS r`)
    // web completed: 1.50 + 0.00 ; ussd completed: 2.21 + 2.51 + 1.00
    expect(Number(r.totalEarnings)).toBeCloseTo(7.22, 2)
    expect(Number(r.totalOrders)).toBe(5)
  })

  it("stats: per-sub-agent breakdown sums both channels", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_earnings_stats('${P}') AS r`)
    const by = new Map<string, any>(r.breakdown.map((b: any) => [b.shop_id, b]))
    expect(Number(by.get(S1).total_orders)).toBe(3)
    expect(Number(by.get(S1).total_sales)).toBeCloseTo(22.0, 2)
    expect(Number(by.get(S1).your_earnings)).toBeCloseTo(2.5, 2)
    expect(Number(by.get(S2).total_orders)).toBe(2)
    expect(Number(by.get(S2).total_sales)).toBeCloseTo(30.22, 2)
    expect(Number(by.get(S2).your_earnings)).toBeCloseTo(4.72, 2)
    expect(by.has(S3)).toBe(false)
  })

  it("stats: a parent with no sales gets zeros and an empty breakdown", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_earnings_stats('${id(999)}') AS r`)
    expect(Number(r.totalEarnings)).toBe(0)
    expect(Number(r.totalOrders)).toBe(0)
    expect(r.breakdown).toEqual([])
  })

  it("history: merges both channels, paid and profitable only, newest first", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_profit_history('${P}', 20, 0) AS r`)
    expect(Number(r.total)).toBe(4)
    expect(r.records.map((x: any) => x.reference_code)).toEqual(["USSD-1", "USSD-3", "WEB-1", "USSD-2"])
    const u1 = r.records[0]
    expect(u1).toMatchObject({ shop_id: S2, network: "MTN", source: "ussd" })
    expect(Number(u1.volume_gb)).toBe(2)
    expect(Number(u1.total_price)).toBeCloseTo(12.41, 2)
    expect(Number(u1.profit_amount)).toBeCloseTo(2.21, 2)
    expect(r.records[2].source).toBe("web")
  })

  it("history: web created_at (no time zone) is read as UTC", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_profit_history('${P}', 20, 0) AS r`)
    const web = r.records.find((x: any) => x.reference_code === "WEB-1")
    expect(new Date(web.created_at).toISOString()).toBe("2026-11-12T08:00:00.000Z")
  })

  it("history: pages with limit and offset, total unchanged", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_profit_history('${P}', 2, 2) AS r`)
    expect(Number(r.total)).toBe(4)
    expect(r.records.map((x: any) => x.reference_code)).toEqual(["WEB-1", "USSD-2"])
  })

  it("history: limit is clamped to 1..50 and offset to >= 0", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_profit_history('${P}', 0, -5) AS r`)
    expect(r.records.length).toBe(1)
    expect(r.records[0].reference_code).toBe("USSD-1")
  })

  it("history: an empty parent returns no records", async () => {
    const { r } = await one(`SELECT public.get_sub_agent_profit_history('${id(999)}', 20, 0) AS r`)
    expect(Number(r.total)).toBe(0)
    expect(r.records).toEqual([])
  })

  it("grants: both functions are service_role only", async () => {
    for (const fn of ["public.get_sub_agent_earnings_stats(uuid)", "public.get_sub_agent_profit_history(uuid,integer,integer)"]) {
      for (const role of ["anon", "authenticated"]) {
        const { ok } = await one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`)
        expect(ok, `${role} on ${fn}`).toBe(false)
      }
      const { ok } = await one(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE') AS ok`)
      expect(ok, `service_role on ${fn}`).toBe(true)
    }
  })
})
