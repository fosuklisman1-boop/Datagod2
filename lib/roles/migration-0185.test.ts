// lib/roles/migration-0185.test.ts
// migrations/0185_role_price_sql.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0185 depends on 0184 (roles tables), packages, users and, for place_api_v2_order, a handful of order tables; all minimal stubs.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0185-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0185_role_price_sql.sql"
const SELFTEST_FILE = "0185_role_price_sql.selftest.sql"
const migration = () => read(FILE)

/** The body of place_api_v2_order between its `AS $$` and the closing `$$;`, CRLF-normalised and trimmed. */
function rpcBody(sql: string): string {
  const head = sql.indexOf("FUNCTION public.place_api_v2_order(")
  expect(head).toBeGreaterThan(-1)
  const start = sql.indexOf("AS $$", head)
  const end = sql.indexOf("\n$$;", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return sql.slice(start, end).replace(/\r\n/g, "\n").trim()
}

describe("0185 migration text", () => {
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
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0185[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("role_price_for is a pinned-search_path SECURITY DEFINER with EXECUTE revoked from anon/authenticated", () => {
    const c = code(migration())
    expect(c).toMatch(/FUNCTION public\.role_price_for\(p_role text, p_package uuid\) RETURNS numeric\s+LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/)
    expect(c).toMatch(/REVOKE ALL ON FUNCTION public\.role_price_for\(text, uuid\) FROM PUBLIC, anon, authenticated;/)
  })

  it("the header records the md5 and 0184 pre-checks", () => {
    const m = migration()
    expect(m).toContain("66cfbadfaa07b8fddfa30ccd3f191921")
    expect(m).toContain("SELECT to_regclass('public.roles');  -- NOT NULL (0184 applied)")
  })

  it("copy-drift: the place_api_v2_order body equals 0142's apart from the one added disjunct", () => {
    const base = rpcBody(read("0142_user_package_prices.sql"))
    const added = rpcBody(migration())
    const DISJUNCT = "\n        OR p_price = public.role_price_for((SELECT u2.role FROM public.users u2 WHERE u2.id = p_user_id), p.id))"
    expect(added.split(DISJUNCT)).toHaveLength(2) // present exactly once
    // removing it (and moving the group's closing paren back) must give 0142's text exactly
    const restored = added.replace("upp.price = p_price)" + DISJUNCT, "upp.price = p_price))")
    expect(restored).toBe(base)
  })

  it("the added disjunct is the only difference in the signature and grants too", () => {
    const m = migration()
    const grants = "REVOKE ALL ON FUNCTION public.place_api_v2_order(uuid, uuid, uuid, text, numeric, numeric, text, text, text)\n  FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.place_api_v2_order(uuid, uuid, uuid, text, numeric, numeric, text, text, text)\n  TO service_role;"
    expect(m).toContain(grants)
    expect(read("0142_user_package_prices.sql")).toContain(grants)
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
  INSERT INTO public.packages(price, dealer_price) VALUES (5, 4.50), (6, 0), (7, NULL);
  INSERT INTO public.users(id, role) VALUES (gen_random_uuid(), 'user'), (gen_random_uuid(), 'dealer'), (gen_random_uuid(), NULL);
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
  return db
}

describe.skipIf(!PGliteCtor)("0185 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0185/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regprocedure('public.role_price_for(text,uuid)') AS t")).rows[0].t).toBeNull()
    expect((await db.query("SELECT to_regprocedure('public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec(migration())
    expect((await db.query("SELECT role_price_for('dealer', id)::text AS p FROM packages WHERE price = 5")).rows[0].p).toBe("4.50")
  }, 60_000)

  it("place_api_v2_order accepts the ladder price, and still rejects a price on no tier", async () => {
    const db = await fresh()
    await db.exec(migration())
    const P = "00000000-0000-0000-0000-0000000000a1"
    const KEY = "00000000-0000-0000-0000-0000000000b1"
    const U_GOLD = "00000000-0000-0000-0000-0000000000c1"
    const U_USER = "00000000-0000-0000-0000-0000000000c2"
    await db.exec(`
      INSERT INTO packages(id, price, dealer_price) VALUES ('${P}', 10, 8);
      INSERT INTO roles(slug, name, rank) VALUES ('selftest_gold', 'Gold', 20);
      INSERT INTO role_package_prices(role_id, package_id, price) SELECT id, '${P}', 6 FROM roles WHERE slug = 'selftest_gold';
      INSERT INTO users(id, role) VALUES ('${U_GOLD}', 'selftest_gold'), ('${U_USER}', 'user');
      INSERT INTO wallets(user_id, balance, total_spent) VALUES ('${U_GOLD}', 100, 0), ('${U_USER}', 100, 0);
      INSERT INTO api_v2_keys(id, user_id, status, environment) VALUES ('${KEY}', '${U_GOLD}', 'active', 'live');
    `)
    await db.exec(`INSERT INTO api_v2_keys(id, user_id, status, environment) VALUES ('00000000-0000-0000-0000-0000000000b2', '${U_USER}', 'active', 'live')`)
    const place = async (user: string, key: string, price: number, ref: string) =>
      (await db.query(
        `SELECT place_api_v2_order('${user}', '${key}', '${P}', 'MTN', 1, ${price}, '0240000000', '${ref}', 'd') AS r`
      )).rows[0].r
    const K_USER = "00000000-0000-0000-0000-0000000000b2"
    expect((await place(U_GOLD, KEY, 6, "g-6")).success).toBe(true) // ladder price of the caller's role
    expect((await place(U_GOLD, KEY, 8, "g-8")).success).toBe(true) // dealer price still accepted
    expect((await place(U_GOLD, KEY, 10, "g-10")).success).toBe(true) // package price still accepted
    expect((await place(U_GOLD, KEY, 7, "g-7")).success).toBe(false) // on no tier
    expect((await place(U_USER, K_USER, 6, "u-6")).success).toBe(false) // another role's row is not theirs
    expect((await place(U_USER, K_USER, 10, "u-10")).success).toBe(true)
  }, 60_000)
})
