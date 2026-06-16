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
