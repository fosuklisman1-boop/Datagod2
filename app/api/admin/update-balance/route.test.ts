import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb, sms: [] as any[], push: [] as any[] }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async (p: any) => { h.sms.push(p); return { success: true } }),
  SMSTemplates: { adminCredited: (a: string, b: string) => `credited ${a} ${b}`, adminDebited: (a: string, b: string) => `debited ${a} ${b}` },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  EmailTemplates: { walletTopUpSuccess: () => ({ subject: "s", html: "h" }) },
}))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async (...a: any[]) => { h.push.push(a) }) }))

import { POST as RAW_POST } from "./route"

const POST = async (body: unknown) =>
  (await RAW_POST(new NextRequest("http://x/api/admin/update-balance", { method: "POST", body: JSON.stringify(body) })))!
const OK = { userId: USER_ID, type: "credit", amount: 12.5, reason: "Refund for order DG-1", expectedBalance: 10 }
const RPC_OK = { transaction_id: "tx-1", reference_id: "ADMIN_CREDIT_abc", type: "credit", amount: 12.5, balance_before: 10, balance_after: 22.5 }

const fake = (rpc: { data: unknown; error: any } = { data: RPC_OK, error: null }) =>
  createFakeDb({
    rpc: () => rpc,
    tables: {
      notifications: () => ({ data: null, error: null }),
      users: () => ({ data: { phone_number: "0244", email: "a@x.com" }, error: null }),
    },
  })

beforeEach(() => {
  h.gate = "admin"
  h.fake = fake()
  h.sms = []
  h.push = []
})

describe("POST /api/admin/update-balance", () => {
  it("returns the gate's response for non-admins and rate-limited admins", async () => {
    h.gate = "forbidden"
    expect((await POST(OK)).status).toBe(403)
    h.gate = "rate_limited"
    expect((await POST(OK)).status).toBe(429)
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("refuses the CRON bypass: adjustments need an admin to attribute them to", async () => {
    h.gate = "cron"
    const res = await POST(OK)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/Admin session required/)
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("validates the body before touching the database", async () => {
    const bad: Array<[string, unknown]> = [
      ["no body", null],
      ["missing userId", { ...OK, userId: undefined }],
      ["bad uuid", { ...OK, userId: "abc" }],
      ["bad type", { ...OK, type: "refund" }],
      ["zero", { ...OK, amount: 0 }],
      ["negative", { ...OK, amount: -5 }],
      ["three decimals", { ...OK, amount: 1.005 }],
      ["string amount", { ...OK, amount: "12" }],
      ["NaN-ish", { ...OK, amount: "abc" }],
      ["over cap", { ...OK, amount: 50000.01 }],
      ["no reason", { ...OK, reason: undefined }],
      ["short reason", { ...OK, reason: "  abcd  " }],
      ["long reason", { ...OK, reason: "x".repeat(501) }],
      ["bad expectedBalance", { ...OK, expectedBalance: "10" }],
    ]
    for (const [label, body] of bad) expect((await POST(body)).status, label).toBe(400)
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("calls admin_wallet_adjust with the admin's own id, trimmed reason and expected balance", async () => {
    const res = await POST({ ...OK, reason: "  Refund for order DG-1  " })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      balance: 22.5,
      data: { balance: 22.5, balanceBefore: 10, transactionId: "tx-1", referenceId: "ADMIN_CREDIT_abc" },
    })
    expect(h.fake.rpcCalls).toEqual([{
      name: "admin_wallet_adjust",
      args: { p_admin_id: ADMIN_ID, p_user_id: USER_ID, p_type: "credit", p_amount: 12.5, p_reason: "Refund for order DG-1", p_expected_balance: 10 },
    }])
    // The route writes neither the wallet, the ledger nor the audit log itself: the RPC does, atomically.
    for (const t of ["wallets", "transactions", "admin_audit_log"]) expect(h.fake.ofTable(t), t).toHaveLength(0)
    // Notifications still go out, carrying the RPC's reference.
    expect(h.fake.ofTable("notifications")[0].payload).toMatchObject([{ user_id: USER_ID, reference_id: "ADMIN_CREDIT_abc" }])
    expect(h.sms[0]).toMatchObject({ reference: "ADMIN_CREDIT_abc", message: "credited 12.50 22.50" })
  })

  it("expectedBalance is optional (null when omitted)", async () => {
    await POST({ ...OK, expectedBalance: undefined })
    expect(h.fake.rpcCalls[0].args.p_expected_balance).toBeNull()
  })

  it("maps RPC refusals to statuses and sends no notifications", async () => {
    const cases: Array<[string, number]> = [
      ["INSUFFICIENT_BALANCE", 409], ["BALANCE_CHANGED", 409], ["AMBIGUOUS_WALLET", 409],
      ["WALLET_NOT_FOUND", 404], ["NOT_ADMIN", 403], ["BAD_INPUT", 400], ["something else", 500],
    ]
    for (const [message, status] of cases) {
      h.fake = fake({ data: null, error: { message, details: "why" } })
      expect((await POST(OK)).status, message).toBe(status)
      expect(h.fake.ofTable("notifications")).toHaveLength(0)
    }
    expect(h.sms).toHaveLength(0)
  })
})
