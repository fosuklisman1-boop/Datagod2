import { describe, it, expect, vi, beforeEach } from "vitest"

const sendSMS = vi.fn()
const sendEmail = vi.fn()
const sendPushToUser = vi.fn()
const subAgentCosts = vi.fn()

vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...a: unknown[]) => sendSMS(...a),
  SMSTemplates: { subAgentCatalogNeeded: (n: string) => `DTGOD: ${n} joined` },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  EmailTemplates: { subAgentCatalogNeeded: (n: string, u: string) => ({ subject: `s ${n}`, html: `h ${u}` }) },
}))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }))
vi.mock("@/lib/shop-commerce/pricing", () => ({ subAgentCosts: (...a: unknown[]) => subAgentCosts(...a) }))

import { notifyOwnerOfRecruit, notifyWaitingSubAgents } from "./notify-owner"

const DAY = 24 * 60 * 60 * 1000

/** Fake db: user_shops (owner + throttle claim), users, waiting sub-agent shops. */
function fakeDb(opts: { alertAt?: string | null; waiting?: { user_id: string }[] } = {}) {
  const state: { alertAt: string | null; readyAt: string | null; claims: number; now: number } = {
    alertAt: opts.alertAt ?? null,
    readyAt: null,
    claims: 0,
    now: Date.now(),
  }
  const db = {
    state,
    from(table: string) {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { phone_number: "0240000000", email: "o@example.com" }, error: null }),
            }),
          }),
        }
      }
      // user_shops
      return {
        select: (cols: string) => {
          const q: any = {
            eq: () => q,
            is: () => q,
            maybeSingle: async () => ({ data: { id: "p1", user_id: "owner1", shop_name: "Owner Shop" }, error: null }),
            then: (res: any) => res({ data: opts.waiting ?? [], error: null }),
          }
          void cols
          return q
        },
        update: (patch: Record<string, unknown>) => {
          const col = Object.keys(patch)[0]
          const key = col === "sub_agent_prices_ready_notified_at" ? "readyAt" : "alertAt"
          const q: any = {
            eq: () => q,
            or: () => q,
            select: async () => {
              const cur = state[key]
              const stale = cur === null || Date.parse(cur) < state.now - DAY
              if (!stale) return { data: [], error: null }
              state[key] = new Date(state.now).toISOString()
              state.claims++
              return { data: [{ id: "p1" }], error: null }
            },
          }
          return q
        },
      }
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  sendSMS.mockResolvedValue({ success: true })
  sendEmail.mockResolvedValue({ success: true })
  sendPushToUser.mockResolvedValue({ sent: 1, removed: 0 })
})

describe("notifyOwnerOfRecruit", () => {
  it("with catalog prices sends one push and no SMS or email", async () => {
    subAgentCosts.mockResolvedValue({ parent: {}, costs: new Map([["pkg1", { cost: 5 }]]) })
    const db = fakeDb()
    await notifyOwnerOfRecruit(db as any, "p1", "New Shop")
    expect(sendPushToUser).toHaveBeenCalledTimes(1)
    expect(sendSMS).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("with no catalog prices sends push, SMS and email", async () => {
    subAgentCosts.mockResolvedValue({ parent: {}, costs: new Map() })
    await notifyOwnerOfRecruit(fakeDb() as any, "p1", "New Shop")
    expect(sendPushToUser).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it("ten calls in a day with none send one SMS and one email; the next day sends again", async () => {
    subAgentCosts.mockResolvedValue({ parent: {}, costs: new Map() })
    const db = fakeDb()
    for (let i = 0; i < 10; i++) await notifyOwnerOfRecruit(db as any, "p1", `S${i}`)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    db.state.now += DAY + 1000
    await notifyOwnerOfRecruit(db as any, "p1", "Next")
    expect(sendSMS).toHaveBeenCalledTimes(2)
    expect(sendEmail).toHaveBeenCalledTimes(2)
  })

  it("does not throw when SMS fails", async () => {
    subAgentCosts.mockResolvedValue({ parent: {}, costs: new Map() })
    sendSMS.mockRejectedValue(new Error("boom"))
    await expect(notifyOwnerOfRecruit(fakeDb() as any, "p1", "New Shop")).resolves.toBeUndefined()
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it("does not throw when the catalog read fails, and still throttles", async () => {
    subAgentCosts.mockRejectedValue(new Error("read failed"))
    const db = fakeDb()
    await expect(notifyOwnerOfRecruit(db as any, "p1", "A")).resolves.toBeUndefined()
    await notifyOwnerOfRecruit(db as any, "p1", "B")
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
})

describe("owner push name handling", () => {
  it("strips newlines and truncates the recruit name to 40 chars in the push", async () => {
    subAgentCosts.mockResolvedValue({ parent: {}, costs: new Map() })
    await notifyOwnerOfRecruit(fakeDb() as any, "p1", "A\nB" + "x".repeat(80))
    const body = (sendPushToUser.mock.calls[0][1] as { body: string }).body
    expect(body).not.toContain("\n")
    expect(body).not.toContain("x".repeat(41))
  })
})

describe("notifyWaitingSubAgents", () => {
  it("pushes to every waiting storefront sub-agent", async () => {
    const db = fakeDb({ waiting: [{ user_id: "u1" }, { user_id: "u2" }] })
    await notifyWaitingSubAgents(db as any, "p1")
    expect(sendPushToUser).toHaveBeenCalledTimes(2)
  })

  it("deep-links waiting joiners to their own pricing setup page, not the owner's catalog", async () => {
    const db = fakeDb({ waiting: [{ user_id: "u1" }] })
    await notifyWaitingSubAgents(db as any, "p1")
    const payload = sendPushToUser.mock.calls[0][1] as { data: { url: string } }
    expect(payload.data.url).toBe("/dashboard/shop-pricing?setup=1")
  })

  it("two activations within 24 hours push once; a day later pushes again", async () => {
    const db = fakeDb({ waiting: [{ user_id: "u1" }] })
    await notifyWaitingSubAgents(db as any, "p1")
    await notifyWaitingSubAgents(db as any, "p1")
    expect(sendPushToUser).toHaveBeenCalledTimes(1)
    db.state.now += DAY + 1000
    await notifyWaitingSubAgents(db as any, "p1")
    expect(sendPushToUser).toHaveBeenCalledTimes(2)
  })

  it("does not throw when a push fails", async () => {
    sendPushToUser.mockRejectedValue(new Error("x"))
    const db = fakeDb({ waiting: [{ user_id: "u1" }] })
    await expect(notifyWaitingSubAgents(db as any, "p1")).resolves.toBeUndefined()
  })
})
