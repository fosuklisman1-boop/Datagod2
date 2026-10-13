import { describe, it, expect } from "vitest"
import { isMissingSenderIdColumn } from "./sms-log-sender"

describe("isMissingSenderIdColumn", () => {
  it("PostgREST schema-cache miss (PGRST204)", () => {
    expect(isMissingSenderIdColumn({ code: "PGRST204", message: "Could not find the 'sender_id' column of 'sms_logs' in the schema cache" })).toBe(true)
  })
  it("Postgres undefined_column (42703)", () => {
    expect(isMissingSenderIdColumn({ code: "42703", message: 'column "sender_id" of relation "sms_logs" does not exist' })).toBe(true)
  })
  it("the code alone is enough, and the message alone is enough", () => {
    expect(isMissingSenderIdColumn({ code: "PGRST204", message: "" })).toBe(true)
    expect(isMissingSenderIdColumn({ message: "Could not find the 'sender_id' column of 'sms_logs'" })).toBe(true)
  })
  it("other errors are not a missing column", () => {
    expect(isMissingSenderIdColumn(null)).toBe(false)
    expect(isMissingSenderIdColumn(undefined)).toBe(false)
    expect(isMissingSenderIdColumn({ code: "23502", message: "null value in column \"phone_number\"" })).toBe(false)
    expect(isMissingSenderIdColumn({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false)
  })
})
