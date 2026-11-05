// Structural checks of 0151_admin_audit_log_fk_set_null.sql. Behaviour (deleting audited users and admins, the
// renamed / duplicate FK case, idempotence) is tested against a real Postgres by
// migrations/tests/0151_admin_audit_log_fk_set_null_local_test.sql.
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8")
const sql = read("migrations", "0151_admin_audit_log_fk_set_null.sql")
const code = sql.replace(/--.*$/gm, "")
const localTest = read("migrations", "tests", "0151_admin_audit_log_fk_set_null_local_test.sql")

describe("0151_admin_audit_log_fk_set_null.sql", () => {
  it("is the only migration numbered 0151", () => {
    expect(readdirSync(join(process.cwd(), "migrations")).filter((f) => f.startsWith("0151_") && f.endsWith(".sql")))
      .toEqual(["0151_admin_audit_log_fk_set_null.sql"])
  })

  it("is one transaction with a lock timeout", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(code).toMatch(/SET LOCAL lock_timeout = '5s';/)
  })

  it("drops every FK on admin_id / target_user_id by column, then re-adds both ON DELETE SET NULL", () => {
    expect(code).toMatch(/contype = 'f'/)
    expect(code).toMatch(/a\.attname IN \('admin_id', 'target_user_id'\)/)
    expect(code).toMatch(/DROP CONSTRAINT %I/)
    expect(code).toMatch(/ALTER COLUMN admin_id DROP NOT NULL/)
    for (const [name, col] of [["admin_audit_log_admin_id_fkey", "admin_id"], ["admin_audit_log_target_user_id_fkey", "target_user_id"]]) {
      expect(code).toMatch(new RegExp(`ADD CONSTRAINT ${name}\\s+FOREIGN KEY \\(${col}\\) REFERENCES auth\\.users\\(id\\) ON DELETE SET NULL NOT VALID;`))
      expect(code).toMatch(new RegExp(`VALIDATE CONSTRAINT ${name};`))
    }
    // nothing else changes
    expect(code).not.toMatch(/\b(DELETE FROM|UPDATE\s+\S+\s+SET|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i)
  })

  it("has a local Postgres test that applies the real 0069 first", () => {
    expect(localTest).toContain("\\i migrations/0069_admin_moderation_sms.sql")
    expect(localTest.match(/\\i migrations\/0151_admin_audit_log_fk_set_null\.sql/g)).toHaveLength(2)
    expect(localTest).toContain("ADMIN_AUDIT_LOG_FK_LOCAL_TEST_OK")
  })
})
