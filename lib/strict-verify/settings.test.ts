import { describe, it, expect } from "vitest"
import { makeFakeDb } from "@/lib/order-queue/fake-db.test-helper"
import { isStrictVerifyOn, STRICT_VERIFY_KEY } from "./settings"

describe("isStrictVerifyOn", () => {
  it("is false when the row is missing", async () => {
    const db = makeFakeDb({ admin_settings: [] })
    expect(await isStrictVerifyOn(db as any)).toBe(false)
  })
  it("is false when enabled is false", async () => {
    const db = makeFakeDb({ admin_settings: [{ key: STRICT_VERIFY_KEY, value: { enabled: false } }] })
    expect(await isStrictVerifyOn(db as any)).toBe(false)
  })
  it("is true when enabled is true", async () => {
    const db = makeFakeDb({ admin_settings: [{ key: STRICT_VERIFY_KEY, value: { enabled: true } }] })
    expect(await isStrictVerifyOn(db as any)).toBe(true)
  })
  it("is true (fail safe) on a read error", async () => {
    const db = makeFakeDb({ admin_settings: [] })
    db.failSelect = () => ({ message: "boom" })
    expect(await isStrictVerifyOn(db as any)).toBe(true)
  })
  it("is true when the read throws", async () => {
    const db = { from: () => { throw new Error("down") } }
    expect(await isStrictVerifyOn(db as any)).toBe(true)
  })
})
