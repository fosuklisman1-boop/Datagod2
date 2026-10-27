import { describe, it, expect, vi } from "vitest"

const h = vi.hoisted(() => ({
  enqueueSendBatched: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  getOrCreateAccountForUser: vi.fn(async (_u: string) => ({ id: "acc-1" })),
  getPendingUnits: vi.fn(async (_a: string) => 4),
  getShopTokens: vi.fn(async (_a: unknown) => ({ shop_name: "x", shop_link: "", shop_phone: "", shop_whatsapp: "" })),
  listRecords: vi.fn(async (_a: string, _i: unknown) => ({ rows: [], total: 0, page: 1, pageSize: 25 })),
  getRecord: vi.fn(async (_a: string, _i: number) => null),
  loadDefaultSender: vi.fn(async (_c: unknown, _a: string) => "FIRSTACTIVE" as string | null),
  notifyAdmins: vi.fn(async (..._a: unknown[]) => {}),
}))
vi.mock("@/lib/sms/send-service", () => ({ enqueueSendBatched: h.enqueueSendBatched }))
vi.mock("@/lib/sms/account-service", () => ({
  getOrCreateAccountForUser: h.getOrCreateAccountForUser,
  getPendingUnits: h.getPendingUnits,
}))
vi.mock("@/lib/sms/shop-context-service", () => ({ getShopTokens: h.getShopTokens }))
vi.mock("@/lib/sms/customer-reads", () => ({ listRecords: h.listRecords, getRecord: h.getRecord }))
vi.mock("@/lib/sms/default-sender", () => ({ loadDefaultSender: h.loadDefaultSender }))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: h.notifyAdmins }))
vi.mock("../store", async (orig) => ({ ...(await orig<typeof import("../store")>()), getAdminClient: () => ({ fake: true }) }))

import {
  lookupSmsAccount,
  resolveSmsSender,
  fetchSmsSenders,
  realSmsEngine,
  realSmsAlert,
  realSmsDeps,
} from "./sms-deps"

// Unique test phones for this file: 0249991065-0249991069.
type Call = [string, ...unknown[]]

function fakeClient(result: { data: unknown; error?: unknown } | "throw") {
  const calls: Call[] = []
  const q: any = {}
  const settle = () => (result === "throw" ? Promise.reject(new Error("db")) : Promise.resolve({ error: null, ...result }))
  for (const m of ["select", "eq", "order", "limit"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return q
    }
  }
  q.maybeSingle = () => settle()
  q.then = (res: any, rej: any) => settle().then(res, rej)
  return { client: { from: (t: string) => (calls.push(["from", t]), q) } as any, calls }
}

describe("lookupSmsAccount (read-only)", () => {
  it("selects the caller's account by user_id only, never creating one", async () => {
    const { client, calls } = fakeClient({ data: { id: "acc-1", user_id: "u1" } })
    expect(await lookupSmsAccount(client, "u1")).toEqual({ id: "acc-1", user_id: "u1" })
    expect(calls).toContainEqual(["from", "sms_accounts"])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(h.getOrCreateAccountForUser).not.toHaveBeenCalled()
  })

  it("null when there is no row; throws on a read error (readers answer 503, not 'no account')", async () => {
    expect(await lookupSmsAccount(fakeClient({ data: null }).client, "u1")).toBeNull()
    await expect(lookupSmsAccount(fakeClient({ data: null, error: { message: "x" } }).client, "u1")).rejects.toThrow()
    await expect(lookupSmsAccount(fakeClient("throw").client, "u1")).rejects.toThrow()
  })
})

describe("resolveSmsSender", () => {
  const account = (over: Record<string, unknown> = {}) => ({ id: "acc-1", default_sender_id: null, ...over }) as any

  it("a requested sender is passed through untouched (the engine validates it)", async () => {
    const { client, calls } = fakeClient({ data: null })
    expect(await resolveSmsSender(client, account(), "MYBRAND")).toBe("MYBRAND")
    expect(calls).toEqual([])
  })

  it("uses the account default only when it is ACTIVE and the same account's", async () => {
    const { client, calls } = fakeClient({ data: { sender_id: "DEFBRAND" } })
    expect(await resolveSmsSender(client, account({ default_sender_id: "row-9" }), null)).toBe("DEFBRAND")
    expect(calls).toContainEqual(["from", "sms_sender_ids"])
    expect(calls).toContainEqual(["eq", "id", "row-9"])
    expect(calls).toContainEqual(["eq", "sms_account_id", "acc-1"])
    expect(calls).toContainEqual(["eq", "local_status", "active"])
  })

  it("falls back to the first active sender (shared loadDefaultSender), then null", async () => {
    const { client } = fakeClient({ data: null })
    expect(await resolveSmsSender(client, account({ default_sender_id: "row-9" }), null)).toBe("FIRSTACTIVE")
    expect(h.loadDefaultSender).toHaveBeenCalledWith(client, "acc-1")
    h.loadDefaultSender.mockResolvedValueOnce(null)
    expect(await resolveSmsSender(client, account(), null)).toBeNull()
  })

  it("a read error on the default lookup throws (never silently falls back)", async () => {
    await expect(
      resolveSmsSender(fakeClient({ data: null, error: { message: "x" } }).client, account({ default_sender_id: "row-9" }), null)
    ).rejects.toThrow()
  })
})

describe("fetchSmsSenders", () => {
  it("selects only the allow-listed columns, account-scoped, oldest first", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "s1" }] })
    expect(await fetchSmsSenders(client, "acc-1")).toEqual([{ id: "s1" }])
    expect(calls).toContainEqual(["from", "sms_sender_ids"])
    expect(calls).toContainEqual(["select", "id, sender_id, local_status, created_at"])
    expect(calls).toContainEqual(["eq", "sms_account_id", "acc-1"])
    expect(calls).toContainEqual(["order", "created_at", { ascending: true }])
  })

  it("throws on error / non-array", async () => {
    await expect(fetchSmsSenders(fakeClient({ data: null, error: { message: "x" } }).client, "a")).rejects.toThrow()
    await expect(fetchSmsSenders(fakeClient({ data: null }).client, "a")).rejects.toThrow()
  })
})

describe("realSmsEngine", () => {
  const base = { userId: "u1", accountId: "acc-1", message: "hello there", recipients: ["0249991065"], tokens: {} as any, senderId: "BRAND" }

  it("calls enqueueSendBatched with the 6 positional args when not scheduled", async () => {
    await realSmsEngine(base)
    expect(h.enqueueSendBatched).toHaveBeenLastCalledWith("u1", "acc-1", "hello there", ["0249991065"], base.tokens, "BRAND")
    expect(h.enqueueSendBatched.mock.calls.at(-1)).toHaveLength(6)
  })

  it("adds ONLY { scheduledFor } as options when scheduled (never a provider)", async () => {
    const at = new Date("2026-11-01T10:00:00Z")
    await realSmsEngine({ ...base, scheduledFor: at })
    const args = h.enqueueSendBatched.mock.calls.at(-1)!
    expect(args).toHaveLength(7)
    expect(args[6]).toEqual({ scheduledFor: at })
  })

  it("lets an engine throw propagate (the handler treats it as ambiguous)", async () => {
    h.enqueueSendBatched.mockRejectedValueOnce(new Error("boom"))
    await expect(realSmsEngine(base)).rejects.toThrow("boom")
  })
})

describe("realSmsAlert / realSmsDeps", () => {
  it("alerts through notifyAdmins and never throws", async () => {
    await realSmsAlert("m")
    expect(h.notifyAdmins).toHaveBeenCalledTimes(1)
    h.notifyAdmins.mockRejectedValueOnce(new Error("x"))
    await expect(realSmsAlert("m")).resolves.toBeUndefined()
  })

  it("wires the read paths to the owner-scoped readers and the send path to getOrCreateAccountForUser", async () => {
    const d = realSmsDeps()
    await d.getOrCreateAccount("u1")
    expect(h.getOrCreateAccountForUser).toHaveBeenCalledWith("u1")
    await d.pendingUnits("acc-1")
    expect(h.getPendingUnits).toHaveBeenCalledWith("acc-1")
    await d.listCampaigns("acc-1", { status: "sent", page: 2 })
    expect(h.listRecords).toHaveBeenCalledWith("acc-1", { status: "sent", page: 2 })
    await d.getCampaign("acc-1", 77)
    expect(h.getRecord).toHaveBeenCalledWith("acc-1", 77)
    await d.shopTokens({ id: "acc-1" } as any)
    expect(h.getShopTokens).toHaveBeenCalled()
    expect(typeof d.now()).toBe("number")
  })
})
