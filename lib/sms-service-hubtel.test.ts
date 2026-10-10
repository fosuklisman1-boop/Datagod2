import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  process.env.SMS_ENABLED = "true"
  process.env.MOOLRE_API_KEY = "test-moolre-key"
  process.env.HUBTEL_SMS_CLIENT_ID = "hub-id"
  process.env.HUBTEL_SMS_CLIENT_SECRET = "hub-secret"
  return {
    axiosGet: vi.fn(),
    axiosPost: vi.fn(),
    hubtelSend: vi.fn(),
    notifyOOF: vi.fn(),
    inserts: [] as Record<string, unknown>[],
    senderRow: null as unknown,
  }
})

vi.mock("axios", () => ({
  default: { get: h.axiosGet, post: h.axiosPost, isAxiosError: () => false },
}))

vi.mock("@/lib/sms/providers/hubtel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/providers/hubtel")>()
  return { ...actual, hubtelSendSingle: h.hubtelSend }
})

vi.mock("@/lib/sms/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/routing")>()
  return { ...actual, getRoutingConfig: vi.fn(async () => ({ primary: "hubtel", fallbacks: ["moolre"] })) }
})

vi.mock("@/lib/sms/notify", () => ({ notifyHubtelOutOfFunds: h.notifyOOF }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table === "sms_logs") h.inserts.push(row)
        return Promise.resolve({ error: null })
      },
      select: () => {
        const chain: any = {
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.senderRow, error: null }),
        }
        return chain
      },
    }),
  })),
}))

import { sendSMS } from "./sms-service"

const base = { phone: "0241234567", message: "hello", type: "notification" } as any
const moolreOk = { data: { status: 1 } }

beforeEach(() => {
  h.axiosGet.mockReset()
  h.axiosPost.mockReset()
  h.hubtelSend.mockReset()
  h.notifyOOF.mockReset()
  h.notifyOOF.mockResolvedValue(undefined)
  h.inserts.length = 0
  h.senderRow = null
  h.axiosGet.mockResolvedValue(moolreOk)
})

describe("sendSMS via Hubtel", () => {
  it("accepted -> success, Moolre not called", async () => {
    h.hubtelSend.mockResolvedValue({ outcome: "accepted", messageId: "m1", messages: [] })
    const r = await sendSMS(base)
    expect(r).toMatchObject({ success: true, provider: "hubtel", messageId: "m1" })
    expect(h.axiosGet).not.toHaveBeenCalled()
    expect(h.inserts[0]).toMatchObject({ provider: "hubtel", status: "sent", moolre_message_id: "m1" })
  })

  it("unknown -> success, no failover, null message id in log", async () => {
    h.hubtelSend.mockResolvedValue({ outcome: "unknown", error: "timeout", messageId: "ignored", messages: [] })
    const r = await sendSMS(base)
    expect(r.success).toBe(true)
    expect(r.provider).toBe("hubtel")
    expect(h.axiosGet).not.toHaveBeenCalled()
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]).toMatchObject({ provider: "hubtel", status: "sent", moolre_message_id: null })
  })

  it("rejected -> fails over to Moolre and logs a hubtel failed row", async () => {
    h.hubtelSend.mockResolvedValue({ outcome: "rejected", error: "bad", messages: [] })
    const r = await sendSMS(base)
    expect(h.axiosGet).toHaveBeenCalledTimes(1)
    expect(r.provider).toBe("moolre")
    expect(h.inserts.find((i) => i.provider === "hubtel")).toMatchObject({
      status: "failed", error_message: "bad", phone_number: "0241234567", message_type: "notification",
    })
  })

  it("out_of_funds -> alerts admins and fails over", async () => {
    h.hubtelSend.mockResolvedValue({ outcome: "out_of_funds", error: "no funds", messages: [] })
    const r = await sendSMS(base)
    expect(h.notifyOOF).toHaveBeenCalledTimes(1)
    expect(h.axiosGet).toHaveBeenCalledTimes(1)
    expect(r.provider).toBe("moolre")
  })

  it("invalid phone -> Hubtel API not called, failed row logged, fails over", async () => {
    await sendSMS({ ...base, phone: "123" })
    expect(h.hubtelSend).not.toHaveBeenCalled()
    expect(h.inserts.find((i) => i.provider === "hubtel")).toMatchObject({
      status: "failed", error_message: "Invalid recipient for Hubtel",
    })
  })

  it("sender longer than 11 chars -> Hubtel API not called", async () => {
    h.senderRow = null
    await sendSMS({ ...base, senderId: "TWELVECHARSX" })
    expect(h.hubtelSend).not.toHaveBeenCalled()
    expect(h.inserts.find((i) => i.provider === "hubtel")).toMatchObject({
      status: "failed", error_message: "Sender ID longer than 11 characters",
    })
  })

  it("custom sender with hubtel primary -> hubtel only (no failover)", async () => {
    h.senderRow = { local_status: "active", mnotify_local_status: "pending" }
    h.hubtelSend.mockResolvedValue({ outcome: "rejected", error: "bad", messages: [] })
    const r = await sendSMS({ ...base, senderId: "MYSHOP" })
    expect(h.hubtelSend).toHaveBeenCalledTimes(1)
    expect(h.hubtelSend.mock.calls[0][1].from).toBe("MYSHOP")
    expect(h.axiosGet).not.toHaveBeenCalled()
    expect(r).toMatchObject({ success: false, provider: "hubtel" })
  })
})
