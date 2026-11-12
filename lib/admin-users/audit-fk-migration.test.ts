// Structural checks of 0176_admin_audit_log_drop_fks.sql. Behaviour (deleting audited users and admins, the
// renamed / duplicate FK case, idempotence) is tested against a real Postgres by
// migrations/tests/0176_admin_audit_log_drop_fks_local_test.sql.
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8")
const sql = read("migrations", "0176_admin_audit_log_drop_fks.sql")
const code = sql.replace(/--.*$/gm, "")
const localTest = read("migrations", "tests", "0176_admin_audit_log_drop_fks_local_test.sql")

describe("0176_admin_audit_log_drop_fks.sql", () => {
  it("is the only migration numbered 0176", () => {
    expect(readdirSync(join(process.cwd(), "migrations")).filter((f) => f.startsWith("0176_") && f.endsWith(".sql")))
      .toEqual(["0176_admin_audit_log_drop_fks.sql"])
  })

  it("is one transaction with a lock timeout", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(code).toMatch(/SET LOCAL lock_timeout = '5s';/)
  })

  it("drops both FKs (real names, IF EXISTS, plus any other FK on the two columns) and adds none back", () => {
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS admin_audit_log_admin_id_fkey;/)
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS admin_audit_log_target_user_id_fkey;/)
    expect(code).toMatch(/a\.attname IN \('admin_id', 'target_user_id'\)/)
    expect(code).not.toMatch(/ADD CONSTRAINT|FOREIGN KEY|REFERENCES|SET NULL/i)
    expect(code).toMatch(/ALTER COLUMN admin_id DROP NOT NULL/)
    expect(code).not.toMatch(/\b(DELETE FROM|UPDATE\s+\S+\s+SET|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i)
  })

  it("names every writer that can insert a NULL admin_id (why the column is nullable)", () => {
    for (const f of ["set-admin", "remove-admin", "settings/network-prefixes", "whatsapp/cashback-visibility", "ussd-hubtel/config"]) {
      expect(sql, f).toContain(`app/api/admin/${f}/route.ts`)
    }
  })

  it("has a local Postgres test that applies the real 0069 first", () => {
    expect(localTest).toContain("\\i migrations/0069_admin_moderation_sms.sql")
    expect(localTest.match(/\\i migrations\/0176_admin_audit_log_drop_fks\.sql/g)).toHaveLength(2)
    expect(localTest).toContain("ADMIN_AUDIT_LOG_FK_LOCAL_TEST_OK")
  })
})
