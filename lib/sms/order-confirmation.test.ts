import { describe, it, expect } from "vitest"
import { canUseOwnSenderForConfirmations } from "./order-confirmation"

type R = { data: unknown; error?: { message: string } | null }
function fakeDb(tables: Record<string, R>) {
  return {
    from(t: string) {
      const c: any = {}
      for (const m of ["select", "eq", "order", "limit"]) c[m] = () => c
      c.maybeSingle = () => Promise.resolve(tables[t] ?? { data: null })
      return c
    },
  }
}

const shop = { data: { user_id: "u1" } }
const active = { data: { id: "a1", status: "active" } }

describe("canUseOwnSenderForConfirmations", () => {
  it("ok with account + sender", async () => {
    const r = await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: shop, sms_accounts: active, sms_sender_ids: { data: { sender_id: "MYSHOP" } } }))
    expect(r).toEqual({ ok: true, accountId: "a1", userId: "u1", senderId: "MYSHOP" })
  })
  it("refuses unknown shop", async () => {
    expect((await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: { data: null } }))).ok).toBe(false)
  })
  it("refuses when there is no sms account", async () => {
    expect((await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: shop, sms_accounts: { data: null } }))).ok).toBe(false)
  })
  it("refuses a suspended or inactive account", async () => {
    for (const status of ["suspended", "inactive"]) {
      const r = await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: shop, sms_accounts: { data: { id: "a1", status } }, sms_sender_ids: { data: { sender_id: "X" } } }))
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/not active/)
    }
  })
  it("refuses with no active sender", async () => {
    const r = await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: shop, sms_accounts: active, sms_sender_ids: { data: null } }))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/sender ID/)
  })
  it("returns ok:false (never throws) when the sender lookup errors", async () => {
    const r = await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: shop, sms_accounts: active, sms_sender_ids: { data: null, error: { message: "db down" } } }))
    expect(r.ok).toBe(false)
  })
  it("returns ok:false on a shop/account lookup error", async () => {
    expect((await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: { data: null, error: { message: "x" } } }))).ok).toBe(false)
    expect((await canUseOwnSenderForConfirmations("s1", fakeDb({ user_shops: shop, sms_accounts: { data: null, error: { message: "x" } } }))).ok).toBe(false)
  })
})
