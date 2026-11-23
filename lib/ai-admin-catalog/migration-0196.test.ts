// migrations/0196_ai_drafts_admin_route_call.sql and its self-test, run in PGlite (WASM Postgres). Nothing here touches a real database.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildRunString, code } from "./migration-0196-run"

const read = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8").replace(/\r\n/g, "\n")
const FILE = "0196_ai_drafts_admin_route_call.sql"
const SELFTEST_FILE = "0196_ai_drafts_admin_route_call.selftest.sql"
const migration = () => read(FILE)

describe("0196 migration text", () => {
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
    expect(s.trimEnd()).toMatch(/RAISE EXCEPTION 'SELFTEST_OK 0196[^']*';\s*END\s*\$selftest\$;$/)
    const doBlock = s.slice(s.lastIndexOf("DO $selftest$"))
    expect(doBlock).not.toMatch(/^\s*END\s*;/im)
  })

  it("rejects a run string that could commit", () => {
    expect(() => buildRunString(migration() + "\nCOMMIT;", read(SELFTEST_FILE))).toThrow()
  })

  it("the self-test never inserts or deletes public.users rows", () => {
    const st = code(read(SELFTEST_FILE))
    expect(st).not.toMatch(/INSERT\s+INTO\s+public\.users/i)
    expect(st).not.toMatch(/DELETE\s+FROM\s+public\.users/i)
  })

  it("the migration lists all seven actions", () => {
    const m = code(migration())
    for (const a of ["wallet_order", "wallet_adjustment", "withdrawal_action", "user_suspension", "role_change", "bulk_status_update", "admin_route_call"]) {
      expect(m).toContain(`'${a}'`)
    }
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
// Prod-shaped stub: email is NOT NULL without a default (like prod). ai_drafts carries the 0188 action CHECK (auto-named
// ai_drafts_action_check, as Postgres names an inline column CHECK).
const STUBS = `CREATE TABLE public.users(id uuid PRIMARY KEY, email text NOT NULL);
  INSERT INTO public.users(id, email) VALUES ('00000000-0000-4000-8000-000000000001', 'stub@example.invalid');
  CREATE TABLE public.ai_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    context text NOT NULL CHECK (context IN ('dashboard', 'admin')),
    action text NOT NULL CHECK (action IN ('wallet_order', 'wallet_adjustment', 'withdrawal_action', 'user_suspension', 'role_change', 'bulk_status_update')),
    params jsonb NOT NULL,
    display jsonb NOT NULL,
    expires_at timestamptz NOT NULL
  );`
async function fresh(): Promise<any> {
  const db = new PGliteCtor()
  await db.exec(ROLES)
  await db.exec(STUBS)
  return db
}
const insertDraft = (action: string) =>
  `INSERT INTO public.ai_drafts(user_id, context, action, params, display, expires_at)
   VALUES ('00000000-0000-4000-8000-000000000001', 'admin', '${action}', '{}', '{}', now() + interval '1 hour')`

describe.skipIf(!PGliteCtor)("0196 in PGlite", () => {
  it("the self-rolling-back run string reports SELFTEST_OK and leaves the old CHECK in place", async () => {
    const db = await fresh()
    await expect(db.exec(buildRunString(migration(), read(SELFTEST_FILE)))).rejects.toThrow(/^SELFTEST_OK 0196/)
    await db.exec("ROLLBACK")
    await expect(db.exec(insertDraft("admin_route_call"))).rejects.toThrow(/check/i)
    await db.exec(insertDraft("wallet_order"))
  }, 60_000)

  it("applies twice, then admin_route_call inserts and bogus is a check_violation", async () => {
    const db = await fresh()
    await db.exec(migration())
    await db.exec(migration())
    await db.exec(insertDraft("admin_route_call"))
    await db.exec(insertDraft("bulk_status_update"))
    let code23514 = ""
    try {
      await db.exec(insertDraft("bogus"))
    } catch (e: any) {
      code23514 = e.code
    }
    expect(code23514).toBe("23514")
  }, 60_000)
})
