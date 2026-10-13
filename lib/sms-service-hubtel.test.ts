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
    /** Errors returned by successive sms_logs inserts (null/absent = ok). */
    insertErrors: [] as ({ code?: string; message: string } | null)[],
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
        if (table !== "sms_logs") return Promise.resolve({ error: null })
        h.inserts.push(row)
        return Promise.resolve({ error: h.insertErrors.shift() ?? null })
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
  h.insertErrors.length = 0
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

  describe("sms_logs.sender_id (Sender ID health)", () => {
    it("records the platform sender, upper-cased, on the accepted row", async () => {
      h.hubtelSend.mockResolvedValue({ outcome: "accepted", messageId: "m1", messages: [] })
      await sendSMS(base)
      const from = h.hubtelSend.mock.calls[0][1].from as string
      expect(h.inserts).toHaveLength(1)
      expect(h.inserts[0]).toMatchObject({ provider: "hubtel", status: "sent", sender_id: from.toUpperCase() })
    })

    it("records a custom sender upper-cased", async () => {
      h.senderRow = { local_status: "active", mnotify_local_status: "pending" }
      h.hubtelSend.mockResolvedValue({ outcome: "accepted", messageId: "m1", messages: [] })
      await sendSMS({ ...base, senderId: "myShop" })
      expect(h.inserts[0]).toMatchObject({ sender_id: "MYSHOP" })
    })

    it("records the sender on the hubtel failed row too", async () => {
      h.hubtelSend.mockResolvedValue({ outcome: "rejected", error: "bad", messages: [] })
      await sendSMS(base)
      const row = h.inserts.find((i) => i.provider === "hubtel")!
      expect(typeof row.sender_id).toBe("string")
      expect(row.sender_id).toBe(String(row.sender_id).toUpperCase())
    })

    for (const err of [
      { code: "PGRST204", message: "Could not find the 'sender_id' column of 'sms_logs' in the schema cache" },
      { code: "42703", message: 'column "sender_id" of relation "sms_logs" does not exist' },
    ]) {
      it(`column missing (${err.code}) -> retries ONCE without sender_id, send still succeeds`, async () => {
        h.hubtelSend.mockResolvedValue({ outcome: "accepted", messageId: "m1", messages: [] })
        h.insertErrors.push(err)
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const r = await sendSMS(base)
        expect(r).toMatchObject({ success: true, provider: "hubtel" })
        expect(h.inserts).toHaveLength(2)
        expect(h.inserts[0]).toHaveProperty("sender_id")
        expect(h.inserts[1]).not.toHaveProperty("sender_id")
        expect(h.inserts[1]).toMatchObject({ provider: "hubtel", status: "sent", moolre_message_id: "m1" })
        expect(warn.mock.calls.some((c) => String(c[0]).includes("sender_id"))).toBe(true)
        warn.mockRestore()
      })
    }

    it("column missing on the failed row -> retried without sender_id, failover unchanged", async () => {
      h.hubtelSend.mockResolvedValue({ outcome: "rejected", error: "bad", messages: [] })
      h.insertErrors.push({ code: "PGRST204", message: "Could not find the 'sender_id' column" })
      const r = await sendSMS(base)
      expect(r.provider).toBe("moolre")
      const hub = h.inserts.filter((i) => i.provider === "hubtel")
      expect(hub).toHaveLength(2)
      expect(hub[1]).not.toHaveProperty("sender_id")
      expect(hub[1]).toMatchObject({ status: "failed", error_message: "bad" })
    })

    it("other insert errors -> no retry, send still succeeds (unchanged fail-soft)", async () => {
      h.hubtelSend.mockResolvedValue({ outcome: "accepted", messageId: "m1", messages: [] })
      h.insertErrors.push({ code: "57014", message: "canceling statement due to statement timeout" })
      const r = await sendSMS(base)
      expect(r).toMatchObject({ success: true, provider: "hubtel" })
      expect(h.inserts).toHaveLength(1)
    })

    it("a retry that also fails never throws out of sendSMS", async () => {
      h.hubtelSend.mockResolvedValue({ outcome: "accepted", messageId: "m1", messages: [] })
      h.insertErrors.push({ code: "PGRST204", message: "x" }, { code: "57014", message: "timeout" })
      const r = await sendSMS(base)
      expect(r.success).toBe(true)
      expect(h.inserts).toHaveLength(2)
    })

    it("skipLogging -> no insert at all", async () => {
      h.hubtelSend.mockResolvedValue({ outcome: "accepted", messageId: "m1", messages: [] })
      await sendSMS({ ...base, skipLogging: true })
      expect(h.inserts).toHaveLength(0)
    })
  })
})
