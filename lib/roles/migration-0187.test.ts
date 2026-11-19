// lib/roles/migration-0187.test.ts
// migrations/0187_roles_hub.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0187 depends on 0184 (roles, role_package_prices, mirror), 0185 (needs order stubs) and 0186 (role_service_rates).
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0187-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0187_roles_hub.sql"
const SELFTEST_FILE = "0187_roles_hub.selftest.sql"
const migration = () => read(FILE)

const CAPS = [
  "buy.data", "buy.airtime", "buy.afa", "buy.bills", "buy.results",
  "shop.storefront", "shop.subagents", "shop.bots", "shop.sms", "shop.text_orders",
  "account.wallet", "account.api", "account.leaderboard", "account.upgrade",
]

describe("0187 migration text", () => {
  it("is one transaction with timeouts and exactly one COMMIT", () => {
    const c = code(migration())
    expect(c).toMatch(/^BEGIN;\s*$/m)
    expect(c).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(c).toMatch(/SET LOCAL statement_timeout = '\d+s';/)
    expect(c.match(/\bCOMMIT\b/g)).toHaveLength(1)
  })

  it("the run string has no COMMIT, no bare END; in the self-test, and ends by raising", () => {
    const run = buildRunString(migration(), read(SELFTEST_FILE))
    const s = code(run)
    expect(s).not.toMatch(/\bCOMMIT\b/i)
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0187[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("the header records the pre-checks", () => {
    const m = migration()
    expect(m).toContain("PRE-CHECKS")
    expect(m).toContain("to_regclass('public.role_permissions')")
    expect(m).toContain("SELECT count(*) FROM public.role_package_prices;")
    expect(m).toMatch(/quiet window/)
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
const STUBS = `
  CREATE TABLE public.packages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price numeric NOT NULL, dealer_price numeric,
    is_available boolean NOT NULL DEFAULT true, network text NOT NULL DEFAULT 'MTN', size text NOT NULL DEFAULT '1');
  CREATE TABLE public.users(id uuid PRIMARY KEY, role text, pricing_mode text NOT NULL DEFAULT 'role');
  CREATE TABLE public.user_package_prices(user_id uuid, package_id uuid, price numeric);
  CREATE TABLE public.api_v2_keys(id uuid PRIMARY KEY, user_id uuid, status text, environment text);
  CREATE TABLE public.wallets(user_id uuid PRIMARY KEY, balance numeric, total_spent numeric, updated_at timestamptz);
  CREATE TABLE public.api_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, api_key_id uuid, api_v2_key_id uuid,
    package_id uuid, network text, volume_gb numeric, price numeric, recipient_phone text, api_reference text, status text,
    created_at timestamptz, updated_at timestamptz, UNIQUE (user_id, api_reference));
  CREATE TABLE public.transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, source text, amount numeric,
    balance_before numeric, balance_after numeric, description text, reference_id text, status text, created_at timestamptz);
`
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  await db.exec(read("0184_roles_foundation.sql"))
  await db.exec(read("0185_role_price_sql.sql"))
  await db.exec(read("0186_role_service_rates.sql"))
  return db
}
async function fresh87(): Promise<any> {
  const db = await fresh()
  await db.exec(migration())
  return db
}

const ACTOR = "00000000-0000-0000-0000-0000000000a1"
const PKG_A = "00000000-0000-0000-0000-0000000000b1"
const PKG_B = "00000000-0000-0000-0000-0000000000b2"
const PKG_C = "00000000-0000-0000-0000-0000000000b3"

async function rows(db: any, sql: string): Promise<any[]> {
  return (await db.query(sql)).rows
}
async function roleId(db: any, slug: string): Promise<string> {
  return (await rows(db, `SELECT id FROM roles WHERE slug = '${slug}'`))[0].id
}
async function mkRole(db: any, slug: string, rank: number, clone: string | null = null): Promise<string> {
  const c = clone ? `'${clone}'` : "NULL"
  return (await rows(db, `SELECT admin_role_create('${ACTOR}', 'test reason', '${slug}', 'Name ${slug}', ${rank}, ${c}::uuid) AS id`))[0].id
}
async function setPrices(db: any, role: string, changes: unknown[], loss = false): Promise<number> {
  return (await rows(db, `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${role}', '${JSON.stringify(changes)}'::jsonb, ${loss}) AS n`))[0].n
}
async function fails(db: any, sql: string, msg?: RegExp): Promise<void> {
  let err: any = null
  try {
    await db.exec(sql)
  } catch (e) {
    err = e
  }
  expect(err, `expected failure: ${sql}`).not.toBeNull()
  if (msg) expect(String(err.message)).toMatch(msg)
}
const seedPackages = `
  INSERT INTO packages(id, price, dealer_price) VALUES ('${PKG_A}', 10, NULL), ('${PKG_B}', 20, NULL), ('${PKG_C}', 30, NULL);
`

describe.skipIf(!PGliteCtor)("0187 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await db.exec(seedPackages)
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0187/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.role_audit_log') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT to_regclass('public.role_permissions') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await fresh87()
    await db.exec(migration())
    expect((await rows(db, "SELECT count(*)::int AS n FROM role_permissions"))[0].n).toBe(28)
  }, 60_000)

  it("seeds user and dealer with the 14 capability keys", async () => {
    const db = await fresh87()
    for (const slug of ["user", "dealer"]) {
      const got = (await rows(db, `SELECT capability FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.slug = '${slug}' ORDER BY 1`)).map((r) => r.capability)
      expect(got).toEqual([...CAPS].sort())
    }
    const themes = await rows(db, "SELECT slug, theme FROM roles WHERE slug IN ('user','dealer') ORDER BY slug")
    expect(themes).toEqual([{ slug: "dealer", theme: { skin: "dealer" } }, { slug: "user", theme: { skin: "default" } }])
  }, 60_000)

  it("set_prices with context writes one 'prices' audit row with actor, reason, before/after", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    const gold = await mkRole(db, "gold", 20)
    expect(await setPrices(db, gold, [{ package_id: PKG_A, price: 9.5 }])).toBe(1)
    let log = await rows(db, `SELECT * FROM role_audit_log WHERE role_id = '${gold}' AND action IN ('prices','price_external')`)
    expect(log).toHaveLength(1)
    expect(log[0].action).toBe("prices")
    expect(log[0].actor_id).toBe(ACTOR)
    expect(log[0].reason).toBe("test reason")
    expect(log[0].loss_override).toBe(false)
    expect(log[0].before).toEqual([])
    expect(log[0].after).toEqual([{ package_id: PKG_A, price: 9.5 }])
    // an update records both sides
    expect(await setPrices(db, gold, [{ package_id: PKG_A, price: 9 }])).toBe(1)
    log = await rows(db, `SELECT * FROM role_audit_log WHERE role_id = '${gold}' AND action = 'prices' ORDER BY id`)
    expect(log).toHaveLength(2)
    expect(log[1].before).toEqual([{ package_id: PKG_A, price: 9.5 }])
    expect(log[1].after).toEqual([{ package_id: PKG_A, price: 9 }])
    // an unchanged price changes nothing and writes nothing
    expect(await setPrices(db, gold, [{ package_id: PKG_A, price: 9 }])).toBe(0)
    expect(await rows(db, `SELECT 1 FROM role_audit_log WHERE role_id = '${gold}' AND action = 'prices'`)).toHaveLength(2)
    // null deletes the row
    expect(await setPrices(db, gold, [{ package_id: PKG_A, price: null }])).toBe(1)
    expect(await rows(db, `SELECT 1 FROM role_package_prices WHERE role_id = '${gold}'`)).toHaveLength(0)
    const del = (await rows(db, `SELECT * FROM role_audit_log WHERE role_id = '${gold}' AND action = 'prices' ORDER BY id`))[2]
    expect(del.before).toEqual([{ package_id: PKG_A, price: 9 }])
    expect(del.after).toEqual([])
  }, 60_000)

  it("a direct UPDATE packages SET dealer_price writes a 'price_external' row with NULL actor", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    const dealer = await roleId(db, "dealer")
    await db.exec(`UPDATE packages SET dealer_price = 8 WHERE id = '${PKG_A}'`)
    const log = await rows(db, `SELECT * FROM role_audit_log WHERE role_id = '${dealer}'`)
    expect(log).toHaveLength(1)
    expect(log[0].action).toBe("price_external")
    expect(log[0].actor_id).toBeNull()
    expect(log[0].after).toEqual([{ package_id: PKG_A, price: 8 }])
    // the mirror itself still works, both directions
    expect((await rows(db, `SELECT price::text AS p FROM role_package_prices WHERE role_id = '${dealer}' AND package_id = '${PKG_A}'`))[0].p).toBe("8.00")
    await setPrices(db, dealer, [{ package_id: PKG_B, price: 15 }])
    expect((await rows(db, `SELECT dealer_price::text AS p FROM packages WHERE id = '${PKG_B}'`))[0].p).toBe("15.00")
    expect(await rows(db, `SELECT 1 FROM role_audit_log WHERE role_id = '${dealer}' AND action = 'prices'`)).toHaveLength(1)
    // the context does not leak into a later direct write
    await db.exec(`UPDATE packages SET dealer_price = 16 WHERE id = '${PKG_B}'`)
    const last = (await rows(db, `SELECT action, actor_id FROM role_audit_log WHERE role_id = '${dealer}' ORDER BY id DESC LIMIT 1`))[0]
    expect(last).toEqual({ action: "price_external", actor_id: null })
  }, 60_000)

  it("set_prices refuses 0, refuses below cost without override, accepts with override and records loss_override", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    await db.exec(`UPDATE packages SET cost_price = 9 WHERE id = '${PKG_A}'`)
    const gold = await mkRole(db, "gold", 20)
    const call = (price: unknown, loss: boolean) =>
      `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${gold}', '[{"package_id":"${PKG_A}","price":${price}}]'::jsonb, ${loss})`
    await fails(db, call(0, false), /greater than 0/)
    await fails(db, call(0, true), /greater than 0/)
    await fails(db, call(-1, true), /greater than 0/)
    await fails(db, call(8.99, false), /below cost/)
    expect(await rows(db, `SELECT 1 FROM role_package_prices WHERE role_id = '${gold}'`)).toHaveLength(0)
    await db.exec(call(9, false))
    await db.exec(call(8, true))
    const log = await rows(db, `SELECT loss_override, after FROM role_audit_log WHERE role_id = '${gold}' AND action = 'prices' ORDER BY id`)
    expect(log.map((r) => r.loss_override)).toEqual([false, true])
    // a null cost never blocks
    await db.exec(`SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${gold}', '[{"package_id":"${PKG_B}","price":0.01}]'::jsonb, false)`)
    // refuses admin, sub_agent, archived
    for (const slug of ["admin", "sub_agent"]) {
      await fails(db, `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${await roleId(db, slug)}', '[]'::jsonb, false)`)
    }
    const arch = await mkRole(db, "old", 30)
    await db.exec(`SELECT admin_role_archive('${ACTOR}', 'test reason', '${arch}')`)
    await fails(db, `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${arch}', '[]'::jsonb, false)`, /archived/)
  }, 60_000)

  it("set_prices only touches listed packages", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    const gold = await mkRole(db, "gold", 20)
    await setPrices(db, gold, [{ package_id: PKG_A, price: 9 }, { package_id: PKG_B, price: 18 }, { package_id: PKG_C, price: 27 }])
    expect(await setPrices(db, gold, [{ package_id: PKG_B, price: 17 }])).toBe(1)
    const got = await rows(db, `SELECT package_id, price::text AS p FROM role_package_prices WHERE role_id = '${gold}' ORDER BY package_id`)
    expect(got).toEqual([{ package_id: PKG_A, p: "9.00" }, { package_id: PKG_B, p: "17.00" }, { package_id: PKG_C, p: "27.00" }])
    // a bad entry anywhere in the batch writes nothing
    await fails(db, `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${gold}', '[{"package_id":"${PKG_A}","price":1},{"package_id":"${PKG_C}","price":0}]'::jsonb, false)`)
    expect((await rows(db, `SELECT price::text AS p FROM role_package_prices WHERE role_id = '${gold}' AND package_id = '${PKG_A}'`))[0].p).toBe("9.00")
    // the same package twice is refused
    await fails(db, `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${gold}', '[{"package_id":"${PKG_A}","price":1},{"package_id":"${PKG_A}","price":2}]'::jsonb, false)`, /duplicate/)
  }, 60_000)

  it("archive refuses a role with members and every system role", async () => {
    const db = await fresh87()
    const gold = await mkRole(db, "gold", 20)
    await db.exec(`INSERT INTO users(id, role) VALUES ('${ACTOR}', 'gold')`)
    await fails(db, `SELECT admin_role_archive('${ACTOR}', 'test reason', '${gold}')`, /role has members/)
    for (const slug of ["user", "dealer", "sub_agent", "admin"]) {
      await fails(db, `SELECT admin_role_archive('${ACTOR}', 'test reason', '${await roleId(db, slug)}')`, /system role/)
    }
    await db.exec(`DELETE FROM users`)
    await db.exec(`SELECT admin_role_archive('${ACTOR}', 'test reason', '${gold}')`)
    expect((await rows(db, `SELECT archived_at IS NOT NULL AS a FROM roles WHERE id = '${gold}'`))[0].a).toBe(true)
    expect((await rows(db, `SELECT action FROM role_audit_log WHERE role_id = '${gold}' ORDER BY id DESC LIMIT 1`))[0].action).toBe("archive")
  }, 60_000)

  it("create refuses 'admin', 'dealer', rank 0, a used rank; clone copies prices, rates, permissions, theme", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    const mk = (slug: string, rank: number) => `SELECT admin_role_create('${ACTOR}', 'test reason', '${slug}', 'N', ${rank}, NULL)`
    await fails(db, mk("admin", 50), /system role/)
    await fails(db, mk("dealer", 50), /system role/)
    await fails(db, mk("user", 50), /system role/)
    await fails(db, mk("sub_agent", 50), /system role/)
    await fails(db, mk("zero", 0), /greater than 0/)
    await fails(db, mk("neg", -3), /greater than 0/)
    await fails(db, mk("tenrank", 10), /already in use/)
    const gold = await mkRole(db, "gold", 20)
    await fails(db, mk("gold", 21), /already in use/)
    // new role: default theme, permissions copied from dealer
    const t = (await rows(db, `SELECT theme, rank, is_system FROM roles WHERE id = '${gold}'`))[0]
    expect(t).toEqual({ theme: { skin: "default" }, rank: 20, is_system: false })
    expect((await rows(db, `SELECT count(*)::int AS n FROM role_permissions WHERE role_id = '${gold}'`))[0].n).toBe(14)
    expect((await rows(db, `SELECT action FROM role_audit_log WHERE role_id = '${gold}'`))[0].action).toBe("create")

    await db.exec(`SELECT admin_role_update('${ACTOR}', 'test reason', '${gold}', '{"description":"d","badge_color":"#001","icon":"star","theme":{"skin":"gold"}}'::jsonb)`)
    await setPrices(db, gold, [{ package_id: PKG_A, price: 9 }, { package_id: PKG_B, price: 18 }])
    await db.exec(`SELECT admin_role_set_rates('${ACTOR}', 'test reason', '${gold}', '[{"service_key":"airtime_fee:mtn","value":1.5}]'::jsonb)`)
    await db.exec(`SELECT admin_role_set_permissions('${ACTOR}', 'test reason', '${gold}', ARRAY['buy.data','account.wallet'])`)

    const copy = await mkRole(db, "gold2", 21, gold)
    const r = (await rows(db, `SELECT description, badge_color, icon, theme FROM roles WHERE id = '${copy}'`))[0]
    expect(r).toEqual({ description: "d", badge_color: "#001", icon: "star", theme: { skin: "gold" } })
    expect((await rows(db, `SELECT package_id, price::text AS p FROM role_package_prices WHERE role_id = '${copy}' ORDER BY package_id`))).toEqual([
      { package_id: PKG_A, p: "9.00" }, { package_id: PKG_B, p: "18.00" },
    ])
    expect(await rows(db, `SELECT service_key, value::text AS v FROM role_service_rates WHERE role_id = '${copy}'`)).toEqual([{ service_key: "airtime_fee:mtn", v: "1.50" }])
    expect((await rows(db, `SELECT capability FROM role_permissions WHERE role_id = '${copy}' ORDER BY 1`)).map((x) => x.capability)).toEqual(["account.wallet", "buy.data"])
    expect((await rows(db, `SELECT action FROM role_audit_log WHERE role_id = '${copy}' AND action IN ('create','clone')`))[0].action).toBe("clone")
    // cloning a system role with a ladder is fine for user/dealer, never for admin/sub_agent
    await mkRole(db, "fromdealer", 22, await roleId(db, "dealer"))
    await fails(db, `SELECT admin_role_create('${ACTOR}', 'test reason', 'x1', 'N', 40, '${await roleId(db, "admin")}')`, /cannot be cloned/)
    await fails(db, `SELECT admin_role_create('${ACTOR}', 'test reason', 'x2', 'N', 41, '${await roleId(db, "sub_agent")}')`, /cannot be cloned/)
  }, 60_000)

  it("a change entry without a price/value key is refused; only an explicit null deletes", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    const gold = await mkRole(db, "gold", 20)
    await setPrices(db, gold, [{ package_id: PKG_A, price: 9 }])
    await fails(db, `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${gold}', '[{"package_id":"${PKG_A}","prise":9}]'::jsonb, false)`, /price key required/)
    await fails(db, `SELECT admin_role_set_prices('${ACTOR}', 'test reason', '${gold}', '[{"package_id":"${PKG_A}"}]'::jsonb, false)`, /price key required/)
    expect(await rows(db, `SELECT 1 FROM role_package_prices WHERE role_id = '${gold}'`)).toHaveLength(1)
    expect(await setPrices(db, gold, [{ package_id: PKG_A, price: null }])).toBe(1)
    await db.exec(`SELECT admin_role_set_rates('${ACTOR}', 'test reason', '${gold}', '[{"service_key":"airtime_fee:mtn","value":2}]'::jsonb)`)
    await fails(db, `SELECT admin_role_set_rates('${ACTOR}', 'test reason', '${gold}', '[{"service_key":"airtime_fee:mtn","valeu":3}]'::jsonb)`, /value key required/)
    expect(await rows(db, `SELECT 1 FROM role_service_rates WHERE role_id = '${gold}'`)).toHaveLength(1)
  }, 60_000)

  it("clone refuses an archived source and records below-cost copied packages in the audit row", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    await db.exec(`UPDATE packages SET cost_price = 9.5 WHERE id = '${PKG_A}'`)
    const gold = await mkRole(db, "gold", 20)
    await setPrices(db, gold, [{ package_id: PKG_A, price: 9.5 }, { package_id: PKG_B, price: 18 }])
    await db.exec(`UPDATE packages SET cost_price = 12 WHERE id = '${PKG_A}'`) // cost rose after pricing
    const copy = await mkRole(db, "gold2", 21, gold)
    const after = (await rows(db, `SELECT after FROM role_audit_log WHERE role_id = '${copy}' AND action = 'clone'`))[0].after
    expect(after.below_cost).toEqual([PKG_A])
    await db.exec(`UPDATE packages SET cost_price = NULL`)
    const copy2 = await mkRole(db, "gold3", 22, gold)
    expect((await rows(db, `SELECT after FROM role_audit_log WHERE role_id = '${copy2}' AND action = 'clone'`))[0].after.below_cost).toEqual([])
    // a create without a source has no below_cost key problem and still audits
    const plain = await mkRole(db, "plain", 23)
    expect((await rows(db, `SELECT action FROM role_audit_log WHERE role_id = '${plain}' AND action = 'create'`))).toHaveLength(1)
    // archived source refused
    await db.exec(`SELECT admin_role_archive('${ACTOR}', 'test reason', '${copy2}')`)
    await fails(db, `SELECT admin_role_create('${ACTOR}', 'test reason', 'gold4', 'N', 24, '${copy2}')`, /archived/)
  }, 60_000)

  it("update patches only allowed keys and refuses admin", async () => {
    const db = await fresh87()
    const gold = await mkRole(db, "gold", 20)
    await fails(db, `SELECT admin_role_update('${ACTOR}', 'test reason', '${gold}', '{"rank":5}'::jsonb)`, /cannot be patched/)
    await fails(db, `SELECT admin_role_update('${ACTOR}', 'test reason', '${gold}', '{"slug":"x"}'::jsonb)`, /cannot be patched/)
    await fails(db, `SELECT admin_role_update('${ACTOR}', 'test reason', '${gold}', '{}'::jsonb)`)
    await fails(db, `SELECT admin_role_update('${ACTOR}', 'test reason', '${await roleId(db, "admin")}', '{"name":"x"}'::jsonb)`, /admin/)
    await db.exec(`SELECT admin_role_update('${ACTOR}', 'test reason', '${gold}', '{"name":"Gold tier"}'::jsonb)`)
    const log = (await rows(db, `SELECT before, after FROM role_audit_log WHERE role_id = '${gold}' AND action = 'update'`))[0]
    expect(log.before.name).toBe("Name gold")
    expect(log.after.name).toBe("Gold tier")
  }, 60_000)

  it("set_rates and set_permissions follow their refusals", async () => {
    const db = await fresh87()
    const gold = await mkRole(db, "gold", 20)
    const rates = (id: string, v: string) => `SELECT admin_role_set_rates('${ACTOR}', 'test reason', '${id}', '${v}'::jsonb)`
    await fails(db, rates(await roleId(db, "dealer"), '[{"service_key":"airtime_fee:mtn","value":1}]'), /system role/)
    await fails(db, rates(gold, '[{"service_key":"Bad Key","value":1}]'), /service_key/)
    await fails(db, rates(gold, '[{"service_key":"airtime_fee:mtn","value":101}]'), /between 0 and 100/)
    expect((await rows(db, rates(gold, '[{"service_key":"airtime_fee:mtn","value":2},{"service_key":"airtime_fee:at","value":3}]')))[0].admin_role_set_rates).toBe(2)
    expect((await rows(db, rates(gold, '[{"service_key":"airtime_fee:mtn","value":null}]')))[0].admin_role_set_rates).toBe(1)
    expect(await rows(db, `SELECT service_key FROM role_service_rates WHERE role_id = '${gold}'`)).toEqual([{ service_key: "airtime_fee:at" }])
    for (const slug of ["admin", "sub_agent"]) {
      await fails(db, `SELECT admin_role_set_permissions('${ACTOR}', 'test reason', '${await roleId(db, slug)}', ARRAY['buy.data'])`)
    }
    await fails(db, `SELECT admin_role_set_permissions('${ACTOR}', 'test reason', '${gold}', ARRAY['Bad Cap'])`, /invalid capability/)
    await db.exec(`SELECT admin_role_set_permissions('${ACTOR}', 'test reason', '${gold}', ARRAY['buy.data','buy.data','shop.sms'])`)
    expect((await rows(db, `SELECT capability FROM role_permissions WHERE role_id = '${gold}' ORDER BY 1`)).map((x) => x.capability)).toEqual(["buy.data", "shop.sms"])
    const last = (await rows(db, `SELECT before, after FROM role_audit_log WHERE role_id = '${gold}' AND action = 'permissions'`))[0]
    expect(last.before).toHaveLength(14)
    expect(last.after).toEqual(["buy.data", "shop.sms"])
  }, 60_000)

  it("swap_rank swaps two custom roles and refuses 'user'", async () => {
    const db = await fresh87()
    const a = await mkRole(db, "gold", 20)
    const b = await mkRole(db, "silver", 30)
    await db.exec(`SELECT admin_role_swap_rank('${ACTOR}', 'test reason', '${a}', '${b}')`)
    expect(await rows(db, `SELECT slug, rank FROM roles WHERE slug IN ('gold','silver') ORDER BY slug`)).toEqual([
      { slug: "gold", rank: 30 }, { slug: "silver", rank: 20 },
    ])
    expect(await rows(db, `SELECT 1 FROM role_audit_log WHERE action = 'rank'`)).toHaveLength(2)
    await fails(db, `SELECT admin_role_swap_rank('${ACTOR}', 'test reason', '${a}', '${await roleId(db, "user")}')`, /user role/)
    await fails(db, `SELECT admin_role_swap_rank('${ACTOR}', 'test reason', '${a}', '${await roleId(db, "admin")}')`, /ranked/)
    await fails(db, `SELECT admin_role_swap_rank('${ACTOR}', 'test reason', '${a}', '${a}')`)
  }, 60_000)

  it("role_audit_log rejects UPDATE, DELETE and TRUNCATE", async () => {
    const db = await fresh87()
    await mkRole(db, "gold", 20)
    await fails(db, `UPDATE role_audit_log SET reason = 'x'`, /append-only/)
    await fails(db, `DELETE FROM role_audit_log`, /append-only/)
    await fails(db, `TRUNCATE role_audit_log`, /append-only/)
  }, 60_000)

  it("every write function refuses a NULL actor and a reason shorter than 3", async () => {
    const db = await fresh87()
    const gold = await mkRole(db, "gold", 20)
    const silver = await mkRole(db, "silver", 30)
    const calls = (actor: string, reason: string) => [
      `SELECT admin_role_create(${actor}, ${reason}, 'zz', 'N', 99, NULL)`,
      `SELECT admin_role_update(${actor}, ${reason}, '${gold}', '{"name":"x"}'::jsonb)`,
      `SELECT admin_role_swap_rank(${actor}, ${reason}, '${gold}', '${silver}')`,
      `SELECT admin_role_archive(${actor}, ${reason}, '${gold}')`,
      `SELECT admin_role_set_prices(${actor}, ${reason}, '${gold}', '[]'::jsonb, false)`,
      `SELECT admin_role_set_rates(${actor}, ${reason}, '${gold}', '[]'::jsonb)`,
      `SELECT admin_role_set_permissions(${actor}, ${reason}, '${gold}', ARRAY['buy.data'])`,
    ]
    for (const s of calls("NULL::uuid", "'test reason'")) await fails(db, s, /actor required/)
    for (const s of calls(`'${ACTOR}'`, "'ab'")) await fails(db, s, /reason required/)
    for (const s of calls(`'${ACTOR}'`, "'  a '")) await fails(db, s, /reason required/)
    for (const s of calls(`'${ACTOR}'`, "NULL")) await fails(db, s, /reason required/)
    expect(await rows(db, `SELECT 1 FROM roles WHERE slug = 'zz'`)).toHaveLength(0)
  }, 60_000)

  it("admin_role_stats counts members and priced packages", async () => {
    const db = await fresh87()
    await db.exec(seedPackages)
    const gold = await mkRole(db, "gold", 20)
    await setPrices(db, gold, [{ package_id: PKG_A, price: 9 }])
    await db.exec(`INSERT INTO users(id, role) VALUES ('${ACTOR}', 'gold')`)
    const s = (await rows(db, `SELECT member_count::int AS m, priced_count::int AS p FROM admin_role_stats() WHERE role_id = '${gold}'`))[0]
    expect(s).toEqual({ m: 1, p: 1 })
  }, 60_000)

  it("anon and authenticated cannot EXECUTE any admin_role_* function or SELECT the new tables", async () => {
    const db = await fresh87()
    const fns = await rows(db, `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public' AND p.proname LIKE 'admin_role_%'`)
    expect(fns.length).toBeGreaterThanOrEqual(8)
    for (const { sig } of fns) {
      for (const who of ["anon", "authenticated", "public"]) {
        const r = who === "public"
          ? await rows(db, `SELECT has_function_privilege('anon', '${sig}', 'EXECUTE') AS ok`)
          : await rows(db, `SELECT has_function_privilege('${who}', '${sig}', 'EXECUTE') AS ok`)
        expect(r[0].ok, `${who} ${sig}`).toBe(false)
      }
      expect((await rows(db, `SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE') AS ok`))[0].ok, sig).toBe(true)
      expect((await rows(db, `SELECT p.prosecdef AS d FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure`))[0].d).toBe(true)
    }
    for (const t of ["role_permissions", "role_audit_log"]) {
      for (const who of ["anon", "authenticated"]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect((await rows(db, `SELECT has_table_privilege('${who}', 'public.${t}', '${priv}') AS ok`))[0].ok, `${who} ${t} ${priv}`).toBe(false)
        }
      }
      expect((await rows(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.${t}'::regclass`))[0].r).toBe(true)
    }
    // service_role: CRUD on role_permissions; only SELECT/INSERT on role_audit_log
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect((await rows(db, `SELECT has_table_privilege('service_role', 'public.role_permissions', '${priv}') AS ok`))[0].ok).toBe(true)
    }
    expect((await rows(db, `SELECT has_table_privilege('service_role', 'public.role_audit_log', 'SELECT') AS ok`))[0].ok).toBe(true)
    expect((await rows(db, `SELECT has_table_privilege('service_role', 'public.role_audit_log', 'INSERT') AS ok`))[0].ok).toBe(true)
    expect((await rows(db, `SELECT has_table_privilege('service_role', 'public.role_audit_log', 'UPDATE') AS ok`))[0].ok).toBe(false)
    expect((await rows(db, `SELECT has_table_privilege('service_role', 'public.role_audit_log', 'DELETE') AS ok`))[0].ok).toBe(false)
  }, 60_000)
})
