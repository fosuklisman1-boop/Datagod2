import { describe, it, expect, vi, beforeEach } from "vitest"
import { DEFAULT_SMS_SETTINGS } from "./platform-settings"

const h = vi.hoisted(() => ({
  settings: null as unknown,
  domains: vi.fn(),
  usage: vi.fn(),
  snapshot: vi.fn(),
  sender: vi.fn(),
  settingsFn: vi.fn(),
}))

vi.mock("./platform-settings", async (orig) => ({ ...(await orig<typeof import("./platform-settings")>()), loadSmsSettings: h.settingsFn }))
vi.mock("./policy-context", () => ({
  loadOwnDomains: h.domains,
  loadUsage: h.usage,
  loadAccountSnapshot: h.snapshot,
  resolveCampaignSender: h.sender,
}))
const evalSpy = vi.hoisted(() => vi.fn())
vi.mock("./policy", async (orig) => {
  const real = await orig<typeof import("./policy")>()
  return { ...real, evaluateSendPolicy: (...a: Parameters<typeof real.evaluateSendPolicy>) => { evalSpy(...a); return real.evaluateSendPolicy(...a) } }
})

import { previewDraft } from "./compose-preview"

const TOKENS = { shop_name: "Kay", shop_link: "https://kay.datagod.store", shop_phone: "0240000000", shop_whatsapp: "" }
const SNAP = { mode: "platform", status: "active", ownerType: "shop", reviewHold: false, audience: "shop_owner" }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  h.settingsFn.mockResolvedValue(DEFAULT_SMS_SETTINGS)
  h.domains.mockResolvedValue(["datagod.store"])
  h.usage.mockResolvedValue({ sendsLastHour: 1, recipientsLast24h: 10 })
  h.snapshot.mockResolvedValue(SNAP)
  h.sender.mockResolvedValue({ kind: "platform", name: null, kycFree: false })
})

describe("previewDraft", () => {
  it("evaluates with the same inputs shadowPolicy builds, using the token-prepared text", async () => {
    const r = await previewDraft({ accountId: "a1", message: "Hi from {shop_name}", senderId: undefined, recipientCount: 5, tokens: TOKENS })
    expect(r.decision).toBe("allow")
    expect(r.code).toBe("OK")
    expect(r.unavailable).toBeUndefined()
    expect(evalSpy).toHaveBeenCalledTimes(1)
    const input = evalSpy.mock.calls[0][0]
    expect(input).toMatchObject({
      account: { audience: "shop_owner", status: "active", mode: "platform", reviewHold: false },
      ownDomains: ["datagod.store"],
      usage: { sendsLastHour: 1, recipientsLast24h: 10 },
      sender: { kind: "platform", name: null, kycFree: false },
      recipientCount: 5,
      message: "Hi from Kay",
    })
    expect(input.settings).toBe(DEFAULT_SMS_SETTINGS)
    expect(h.usage).toHaveBeenCalledWith("a1")
    expect(h.snapshot).toHaveBeenCalledWith("a1")
    expect(h.sender).toHaveBeenCalledWith("a1", undefined)
  })

  it("unknown sender -> reject SENDER_NOT_ALLOWED without evaluating", async () => {
    h.sender.mockResolvedValue(null)
    const r = await previewDraft({ accountId: "a1", message: "hello there", senderId: "NOPE", recipientCount: 1, tokens: TOKENS })
    expect(r).toMatchObject({ decision: "reject", code: "SENDER_NOT_ALLOWED" })
    expect(r.reason).toBeTruthy()
    expect(evalSpy).not.toHaveBeenCalled()
  })

  it("surfaces a cap rejection from the evaluator", async () => {
    const r = await previewDraft({ accountId: "a1", message: "hello there", recipientCount: 100000, tokens: TOKENS })
    expect(r.decision).not.toBe("allow")
    expect(r.code).toBe("CAP_PER_SEND")
  })

  it("never throws: evaluator/context errors -> advisory allow + unavailable", async () => {
    h.usage.mockRejectedValue(new Error("boom"))
    const r = await previewDraft({ accountId: "a1", message: "hello there", recipientCount: 1, tokens: TOKENS })
    expect(r).toMatchObject({ decision: "allow", code: "OK", unavailable: true, flags: [] })
  })

  it("account not found -> advisory unavailable", async () => {
    h.snapshot.mockResolvedValue(null)
    const r = await previewDraft({ accountId: "a1", message: "hello there", recipientCount: 1, tokens: TOKENS })
    expect(r).toMatchObject({ decision: "allow", code: "OK", unavailable: true })
  })

  it("message empty after stripping -> advisory unavailable, no throw", async () => {
    const r = await previewDraft({ accountId: "a1", message: "🎉🎊", recipientCount: 1, tokens: TOKENS })
    expect(r.unavailable).toBe(true)
    expect(evalSpy).not.toHaveBeenCalled()
  })
})
