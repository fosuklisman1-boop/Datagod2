// lib/roles/migration-0186.test.ts
// migrations/0186_role_service_rates.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
// 0186 depends only on 0184 (roles). Plain additive table: no seed, no triggers, no functions.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0186-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0186_role_service_rates.sql"
const SELFTEST_FILE = "0186_role_service_rates.selftest.sql"
const migration = () => read(FILE)

describe("0186 migration text", () => {
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
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0186[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("defines the table with the exact columns, checks and key", () => {
    const c = code(migration())
    expect(c).toMatch(/CREATE TABLE IF NOT EXISTS public\.role_service_rates/)
    expect(c).toMatch(/role_id\s+uuid NOT NULL REFERENCES public\.roles\(id\) ON DELETE CASCADE/)
    expect(c).toContain("CHECK (service_key ~ '^[a-z_]+:[a-z0-9_]+$')")
    expect(c).toMatch(/value\s+numeric\(6,2\) NOT NULL CHECK \(value >= 0 AND value <= 100\)/)
    expect(c).toMatch(/updated_at\s+timestamptz NOT NULL DEFAULT now\(\)/)
    expect(c).toContain("PRIMARY KEY (role_id, service_key)")
  })

  it("enables RLS, adds no policy, revokes from client roles, grants service_role; no seed, trigger or function", () => {
    const c = code(migration())
    expect(c).toContain("ALTER TABLE public.role_service_rates ENABLE ROW LEVEL SECURITY;")
    expect(c).toContain("REVOKE ALL ON public.role_service_rates FROM PUBLIC, anon, authenticated;")
    expect(c).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_service_rates TO service_role;")
    expect(c).not.toMatch(/CREATE\s+POLICY/i)
    expect(c).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION)/i)
    expect(c).not.toMatch(/\bINSERT\s+INTO\b/i)
  })

  it("the header records the pre-checks", () => {
    const m = migration()
    expect(m).toContain("SELECT to_regclass('public.role_service_rates');  -- NULL")
    expect(m).toContain("SELECT to_regclass('public.roles');  -- NOT NULL (0184 applied)")
  })
})

describe("buildRunString guard (negative cases)", () => {
  const HEAD = "BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\n"
  const mig = (mid = "", tail = "COMMIT;\n") => HEAD + mid + tail
  const ST = "-- header\nDO $selftest$\nBEGIN\n  RAISE EXCEPTION 'SELFTEST_OK 0186 (rolled back)';\nEND $selftest$;\n"

  it("accepts a clean input, and END; inside a $fn$ body", () => {
    expect(() => buildRunString(mig(), ST)).not.toThrow()
    const body = "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $fn$\nBEGIN\n  RETURN 1;\nEND;\n$fn$;\n"
    expect(() => buildRunString(mig(body), ST)).not.toThrow()
  })
  it("rejects a duplicate COMMIT", () => {
    expect(() => buildRunString(mig("COMMIT;\n"), ST)).toThrow()
  })
  it("rejects a COMMIT hidden after a '--' literal on one line", () => {
    expect(() => buildRunString(mig("SELECT '--'; COMMIT;\n"), ST)).toThrow()
  })
  it("rejects END TRANSACTION outside a body", () => {
    expect(() => buildRunString(mig("END TRANSACTION;\n"), ST)).toThrow()
  })
  it("rejects END WORK, ABORT and PREPARE TRANSACTION outside a body", () => {
    expect(() => buildRunString(mig("END WORK;\n"), ST)).toThrow()
    expect(() => buildRunString(mig("ABORT;\n"), ST)).toThrow()
    expect(() => buildRunString(mig("PREPARE TRANSACTION 'x';\n"), ST)).toThrow()
  })
  it("rejects a mid-line SELECT 1; END;", () => {
    expect(() => buildRunString(mig("SELECT 1; END;\n"), ST)).toThrow()
  })
  it("rejects ROLLBACK outside a body", () => {
    expect(() => buildRunString(mig("ROLLBACK;\n"), ST)).toThrow()
  })
  it("rejects a run string with no BEGIN;", () => {
    expect(() => buildRunString("SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\nCOMMIT;\n", ST)).toThrow()
  })
  it("rejects a self-test that does not end by raising SELFTEST_OK", () => {
    expect(() => buildRunString(mig(), "DO $selftest$\nBEGIN\n  NULL;\nEND $selftest$;\n")).toThrow()
  })
  it("rejects a self-test with no column-0 DO", () => {
    expect(() => buildRunString(mig(), "  DO $selftest$ BEGIN END $selftest$;\n")).toThrow()
  })
  it("rejects a bare END; inside the self-test", () => {
    expect(() => buildRunString(mig(), "DO $selftest$\nBEGIN\n  END;\n  RAISE EXCEPTION 'SELFTEST_OK';\nEND $selftest$;\n")).toThrow()
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
`
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  await db.exec(read("0184_roles_foundation.sql"))
  return db
}

describe.skipIf(!PGliteCtor)("0186 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves nothing behind", async () => {
    const db = await fresh()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0186/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT to_regclass('public.role_service_rates') AS t")).rows[0].t).toBeNull()
  }, 60_000)

  it("applies twice without error and the table works", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec(migration())
    await db.exec("INSERT INTO role_service_rates(role_id, service_key, value) SELECT id, 'airtime_fee:mtn', 1.5 FROM roles WHERE slug = 'dealer'")
    expect((await db.query("SELECT value::text AS v FROM role_service_rates")).rows[0].v).toBe("1.50")
  }, 60_000)
})
