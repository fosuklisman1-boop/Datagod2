import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.hoisted — must exist before broadcast-drain imports supabase/providers at module level.
const h = vi.hoisted(() => {
  const state = {
    inserted: [] as Record<string, unknown>[],
    insertError: null as { message: string } | null,
  }
  const fake = {
    from: (_table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted.push(...rows)
        return Promise.resolve({ error: state.insertError })
      },
      // roles path (unused in these tests) — no-op chain so nothing crashes.
      select: () => ({
        in: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
    }),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn() }))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(),
  EmailTemplates: { broadcastMessage: () => ({ subject: "", html: "" }) },
}))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn(), sendWhatsAppTemplate: vi.fn() }))

import { enqueueRecipients } from "./broadcast-drain"

beforeEach(() => {
  h.state.inserted = []
  h.state.insertError = null
})

describe("enqueueRecipients — per-recipient rendered_message", () => {
  it("stores each specific recipient's renderedMessage in rendered_message", async () => {
    const n = await enqueueRecipients(h.fake as never, "b1", {
      targetType: "specific",
      specificUsers: [
        { phone: "0241111111", name: "Ama", renderedMessage: "Hi Ama" },
        { phone: "0242222222", name: "Kofi", renderedMessage: "Hi Kofi" },
      ],
    })
    expect(n).toBe(2)
    expect(h.state.inserted).toHaveLength(2)
    expect(h.state.inserted[0]).toMatchObject({ phone: "0241111111", rendered_message: "Hi Ama" })
    expect(h.state.inserted[1]).toMatchObject({ phone: "0242222222", rendered_message: "Hi Kofi" })
  })

  it("defaults rendered_message to null when none is provided (back-compat with role/specific sends)", async () => {
    await enqueueRecipients(h.fake as never, "b1", {
      targetType: "specific",
      specificUsers: [{ phone: "0241111111", name: "Ama" }],
    })
    expect(h.state.inserted[0].rendered_message).toBeNull()
  })

  it("de-duplicates recipients by phone before enqueue", async () => {
    const n = await enqueueRecipients(h.fake as never, "b1", {
      targetType: "specific",
      specificUsers: [
        { phone: "0241111111", renderedMessage: "A" },
        { phone: "0241111111", renderedMessage: "B" }, // duplicate phone
      ],
    })
    expect(n).toBe(1)
    expect(h.state.inserted).toHaveLength(1)
  })
})

// ── SMS provider override ────────────────────────────────────────────────────
import { drainBroadcasts } from "./broadcast-drain"
import { sendSMS } from "@/lib/sms-service"
import { parseSmsProvider } from "./sms/provider-pick"

function drainFake(providerResult: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const bc = { id: "b1", channels: ["sms"], subject: null, message: "hello" }
  const rec = { id: "r1", broadcast_id: "b1", user_id: null, email: null, phone: "0241111111", name: null, rendered_message: null, attempts: 0, channel_status: {} }
  return {
    from: (_t: string) => ({
      update: () => ({
        eq: () => ({ lt: () => Promise.resolve({}), then: (f: (v: unknown) => unknown) => f({}) }),
      }),
      select: (cols: string) => {
        if (cols === "id, sms_provider") {
          return { in: () => Promise.resolve({ data: providerResult.data ?? null, error: providerResult.error ?? null }) }
        }
        return { eq: () => Promise.resolve({ data: [bc], error: null }) }
      },
    }),
    rpc: (name: string) =>
      Promise.resolve(name === "claim_broadcast_recipients" ? { data: [rec], error: null } : { data: null, error: null }),
  }
}

describe("drainBroadcasts — sms_provider", () => {
  beforeEach(() => {
    vi.mocked(sendSMS).mockReset()
    vi.mocked(sendSMS).mockResolvedValue({ success: true } as never)
  })

  it("passes provider when broadcast.sms_provider is hubtel", async () => {
    await drainBroadcasts(drainFake({ data: [{ id: "b1", sms_provider: "hubtel" }] }) as never, { broadcastId: "b1" })
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendSMS).mock.calls[0][0]).toMatchObject({ provider: "hubtel", type: "broadcast" })
  })

  it.each([["global"], [null]])("passes no provider key for %s", async (v) => {
    await drainBroadcasts(drainFake({ data: [{ id: "b1", sms_provider: v }] }) as never, { broadcastId: "b1" })
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendSMS).mock.calls[0][0]).not.toHaveProperty("provider")
  })

  it("missing column => no override and drain proceeds", async () => {
    const f = drainFake({ error: { code: "42703", message: "column broadcast_logs.sms_provider does not exist" } })
    await drainBroadcasts(f as never, { broadcastId: "b1" })
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendSMS).mock.calls[0][0]).not.toHaveProperty("provider")
  })

  it("other error => drain fails and nothing is sent", async () => {
    await expect(
      drainBroadcasts(drainFake({ error: { message: "connection reset" } }) as never, { broadcastId: "b1" }),
    ).rejects.toBeTruthy()
    expect(sendSMS).not.toHaveBeenCalled()
  })
})

describe("parseSmsProvider", () => {
  it("accepts valid, treats empty as undefined, rejects others", () => {
    expect(parseSmsProvider("moolre")).toBe("moolre")
    expect(parseSmsProvider("hubtel")).toBe("hubtel")
    expect(parseSmsProvider("global")).toBe("global")
    expect(parseSmsProvider(undefined)).toBeUndefined()
    expect(parseSmsProvider("")).toBeUndefined()
    expect(parseSmsProvider("mnotify")).toBe("invalid")
    expect(parseSmsProvider(5)).toBe("invalid")
  })
})
