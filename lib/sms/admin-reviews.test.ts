import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  accounts: [] as any[], users: [] as any[], senders: [] as any[], reviews: [] as any[], calls: [] as { table: string; ops: { m: string; args: any[] }[] }[],
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const ops: { m: string; args: any[] }[] = []
      h.calls.push({ table, ops })
      const c: any = {}
      for (const m of ["select", "eq", "in", "order", "limit"]) c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
      c.then = (res: any, rej: any) => {
        const data = table === "sms_accounts" ? h.accounts : table === "users" ? h.users : table === "sms_sender_ids" ? h.senders : h.reviews
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
      return c
    },
  }),
}))
vi.mock("./kyc-service", () => ({ listKycForAdmin: (status: string) => Promise.resolve(h.reviews.filter((r) => status === "all" || r.status === status)) }))

import { attachAccounts, loadAccountInfo, listBusinessReviews, listSenderIdsForAdmin, type AccountInfo } from "./admin-reviews"

beforeEach(() => { h.accounts = []; h.users = []; h.senders = []; h.reviews = []; h.calls = [] })

const info: AccountInfo = { user_id: "u1", email: "a@b.com", mode: "platform", owner_type: "shop" }

describe("attachAccounts (pure)", () => {
  it("adds the account, or null when unknown / ownerless", () => {
    const out = attachAccounts([{ sms_account_id: "a1" }, { sms_account_id: "zz" }, { sms_account_id: null }], new Map([["a1", info]]))
    expect(out.map((r) => r.account)).toEqual([info, null, null])
  })
})

describe("loadAccountInfo", () => {
  it("joins accounts to user emails", async () => {
    h.accounts = [{ id: "a1", user_id: "u1", mode: "business", owner_type: "shop" }]
    h.users = [{ id: "u1", email: "x@y.com" }]
    const m = await loadAccountInfo(["a1"])
    expect(m.get("a1")).toEqual({ user_id: "u1", email: "x@y.com", mode: "business", owner_type: "shop" })
  })
  it("returns an empty map without querying for no ids", async () => {
    expect((await loadAccountInfo([])).size).toBe(0)
    expect(h.calls).toHaveLength(0)
  })
  it("queries in chunks of 100 ids", async () => {
    await loadAccountInfo(Array.from({ length: 250 }, (_, i) => `a${i}`))
    expect(h.calls.filter((c) => c.table === "sms_accounts")).toHaveLength(3)
  })
})

describe("listBusinessReviews", () => {
  it("enriches reviews and falls back to 'submitted' on a bad status", async () => {
    h.reviews = [{ id: "r1", sms_account_id: "a1", status: "submitted" }, { id: "r2", sms_account_id: "a1", status: "approved" }]
    h.accounts = [{ id: "a1", user_id: "u1", mode: "platform", owner_type: "shop" }]
    h.users = [{ id: "u1", email: "x@y.com" }]
    const out = await listBusinessReviews("bogus")
    expect(out.map((r) => r.id)).toEqual(["r1"])
    expect(out[0].account?.email).toBe("x@y.com")
  })
})

describe("listSenderIdsForAdmin", () => {
  it("filters by status and scope and attaches accounts", async () => {
    h.senders = [{ id: "s1", sender_id: "KINGS", local_status: "pending", sms_account_id: "a1" }, { id: "s2", sender_id: "DATAGOD", local_status: "active", sms_account_id: null }]
    h.accounts = [{ id: "a1", user_id: "u1", mode: "platform", owner_type: "shop" }]
    await listSenderIdsForAdmin("pending", "tenant")
    const q = h.calls.find((c) => c.table === "sms_sender_ids")!
    expect(q.ops.filter((o) => o.m === "eq").map((o) => o.args)).toContainEqual(["local_status", "pending"])
  })
  it("ignores unknown status values (no filter)", async () => {
    await listSenderIdsForAdmin("nonsense" as any, "all")
    const q = h.calls.find((c) => c.table === "sms_sender_ids")!
    expect(q.ops.some((o) => o.m === "eq" && o.args[0] === "local_status")).toBe(false)
  })
})
