import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeTtb } from "@/lib/text-to-buy/fake-db.test-helper"
import type { Offer, OfferResult } from "@/lib/text-to-buy/catalogue"

const h = vi.hoisted(() => ({
  client: null as unknown,
  map: { MTN: ["20"], TELECEL: [] as string[], AT: [] as string[] },
  confirm: vi.fn(),
  reply: vi.fn(),
  readAi: vi.fn(),
  resolve: vi.fn(),
  prices: vi.fn(),
  accept: vi.fn(),
  processSpy: vi.fn(),
  notify: vi.fn(),
  surface: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return h.client
  },
}))
const authMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => authMock(...a) }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: true, map: h.map })) }))
vi.mock("@/lib/payment-gateway/start", () => ({ resolveSurfaceGateway: h.surface }))
vi.mock("@/lib/ussd/gateway-charge", () => ({ isUssdHubtelPayer: vi.fn() }))
vi.mock("@/lib/ussd/handlers/bundles", () => ({ handleConfirm: h.confirm }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), notifyAdmins: h.notify }))
vi.mock("@/lib/text-to-buy/send-reply", () => ({ sendReply: h.reply }))
vi.mock("@/lib/text-to-buy/ai-reader", () => ({ readWithAi: h.readAi }))
vi.mock("@/lib/text-to-buy/catalogue", () => ({
  resolveOffer: h.resolve,
  listPrices: h.prices,
  parseSizeMb: (s: string) => Math.round(Number(s) * 1000),
  sizeLabel: (s: string) => `${s}GB`,
  sessionForOffer: (sender: string, o: Offer) => ({ dialingPhone: "+233" + sender.slice(1), network: o.network, bundleId: o.bundleId, bundleSize: o.size, bundlePrice: o.price, recipientPhone: o.recipientLocal }),
}))
// The real processInbound, wrapped so the test can see how the route called it; acceptInbound is spied to prove it is never used.
vi.mock("@/lib/text-to-buy/handle-inbound", async (orig) => {
  const actual = await orig<typeof import("@/lib/text-to-buy/handle-inbound")>()
  return {
    ...actual,
    acceptInbound: h.accept,
    processInbound: (...args: Parameters<typeof actual.processInbound>) => {
      h.processSpy(...args)
      return actual.processInbound(...args)
    },
  }
})

import { POST } from "./route"
import { resetTryAllowance } from "@/lib/text-to-buy/admin-http"

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SENDER = "0200000101"
const tier = { effectivePriceTier: "customer", subAgentParentShopId: null, userId: null, mtnWhitelistActive: false } as unknown as Offer["tier"]
const offer: Offer = { network: "MTN", networkLabel: "MTN", bundleId: "b5", size: "5", price: 23.69, recipientLocal: SENDER, gift: false, tier, paystackProvider: "mtn" }
const ok: OfferResult = { ok: true, offer }

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/admin/text-to-buy/try", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }))

let fake: ReturnType<typeof makeFakeTtb>
let spies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  vi.clearAllMocks()
  resetTryAllowance()
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  authMock.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  fake = makeFakeTtb({
    admin_settings: [{ key: "ttb_main_enabled", value: { value: false } }],
  })
  fake.db.rpcImpl = (name) =>
    name === "ttb_counts" ? { data: [{ prompts_unpaid: 0, replies: 0, ai_reads: 0, not_understood: 0 }], error: null } : { data: 0, error: null }
  h.client = fake.client
  h.map = { MTN: ["20"], TELECEL: [], AT: [] }
  h.resolve.mockResolvedValue(ok)
  h.confirm.mockResolvedValue({ type: "end", message: "", orderId: "6f0c1a9e-0163-4163-8163-0000000000c1", amount: 23.69 })
  h.reply.mockResolvedValue({ sent: true })
  h.readAi.mockResolvedValue({ kind: "not_order" })
  h.surface.mockResolvedValue({ gateway: "paystack", feeBearer: "customer" })
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => vi.restoreAllMocks())

const snapshot = () => JSON.stringify(fake.db.tables)

describe("auth and validation", () => {
  it("401 passthrough, 403 non-admin, 403 for the cron bearer", async () => {
    authMock.mockResolvedValue({ errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await post({ line: "main", sender: SENDER, text: "5gb" })).status).toBe(401)
    authMock.mockResolvedValue({ isAdmin: false, userId: "u1" })
    expect((await post({ line: "main", sender: SENDER, text: "5gb" })).status).toBe(403)
    authMock.mockResolvedValue({ isAdmin: true })
    const res = await post({ line: "main", sender: SENDER, text: "5gb" })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("admin_user_required")
    expect(h.processSpy).not.toHaveBeenCalled()
  })
  it("validates line, sender and text (1..500 after trimming)", async () => {
    const cases: [unknown, string][] = [
      ["nope", "invalid_body"], [[], "invalid_body"],
      [{ line: "shop", sender: SENDER, text: "5gb" }, "invalid_line"], [{ sender: SENDER, text: "5gb" }, "invalid_line"],
      [{ line: "main", sender: "123", text: "5gb" }, "invalid_sender"], [{ line: "main", text: "5gb" }, "invalid_sender"],
      [{ line: "main", sender: SENDER, text: "" }, "invalid_text"], [{ line: "main", sender: SENDER, text: "   " }, "invalid_text"],
      [{ line: "main", sender: SENDER, text: 5 }, "invalid_text"], [{ line: "main", sender: SENDER }, "invalid_text"],
      [{ line: "main", sender: SENDER, text: "x".repeat(501) }, "invalid_text"],
    ]
    for (const [body, err] of cases) {
      const res = await post(body)
      expect([JSON.stringify(body).slice(0, 40), res.status]).toEqual([JSON.stringify(body).slice(0, 40), 400])
      expect((await res.json()).error).toBe(err)
    }
    expect(h.processSpy).not.toHaveBeenCalled()
    expect((await post({ line: "main", sender: SENDER, text: "x".repeat(500) })).status).toBe(200)
  })
  it("limits each admin to 10 tries a minute", async () => {
    for (let i = 0; i < 10; i++) expect((await post({ line: "main", sender: SENDER, text: "5gb" })).status).toBe(200)
    const res = await post({ line: "main", sender: SENDER, text: "5gb" })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe("rate_limited")
  })
})

describe("dry run", () => {
  it("calls processInbound with dryRun true, a synthetic uuid, no receive time, and never acceptInbound", async () => {
    const res = await post({ line: "main", sender: "+233200000101", text: "  5gb  " })
    expect(res.status).toBe(200)
    expect(h.accept).not.toHaveBeenCalled()
    expect(h.processSpy).toHaveBeenCalledTimes(1)
    const [, messageId, input, settings, deps] = h.processSpy.mock.calls[0]
    expect(messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(input).toMatchObject({ line: "main", from: SENDER, text: "5gb", receivedAt: null })
    expect(input.now).toBeInstanceOf(Date)
    expect(settings.mainEnabled).toBe(false) // the feature being off does not stop a dry run
    expect(deps).toEqual({ dryRun: true })
  })

  it("returns only readBy, outcome and reply", async () => {
    const body = await (await post({ line: "main", sender: SENDER, text: "5gb" })).json()
    expect(Object.keys(body).sort()).toEqual(["outcome", "readBy", "reply"])
    expect(body).toMatchObject({ readBy: "rules", outcome: "prompted" })
    expect(body.reply).toContain("23.69")
  })

  it("never confirms an order, sends a reply, links an order, alerts, or writes any row", async () => {
    const before = snapshot()
    const res = await post({ line: "main", sender: SENDER, text: "5gb" })
    expect((await res.json()).outcome).toBe("prompted")
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.reply).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
    expect(snapshot()).toBe(before)
    expect(fake.db.tables.ttb_orders).toEqual([])
    expect(fake.db.tables.ttb_messages).toEqual([])
    expect(fake.db.tables.ttb_conversations).toEqual([])
  })

  it("a question (conversation state) and a price list are not saved either", async () => {
    h.resolve.mockResolvedValue({ ok: false, reason: "need_recipient", networkLabel: "MTN" })
    const before = snapshot()
    expect((await (await post({ line: "main", sender: SENDER, text: "5gb mtn" })).json()).outcome).toBe("asked")
    h.prices.mockResolvedValue({ networkLabel: "MTN", items: [{ size: "1GB", priceGhs: 5 }] })
    expect((await (await post({ line: "main", sender: SENDER, text: "prices" })).json()).outcome).toBe("keyword")
    expect(snapshot()).toBe(before)
    expect(h.reply).not.toHaveBeenCalled()
  })

  it("hands unreadable text to the AI reader (the one real cost) and still writes nothing", async () => {
    const before = snapshot()
    const body = await (await post({ line: "main", sender: SENDER, text: "pls abeg i dey need some of that thing" })).json()
    expect(h.readAi).toHaveBeenCalledTimes(1)
    expect(body.readBy).toBe("ai")
    expect(snapshot()).toBe(before)
  })

  it("a blocked pretend sender reports blocked", async () => {
    fake.db.tables.ttb_blocked.push({ sender: SENDER, reason: null, blocked_by: ADMIN })
    expect((await (await post({ line: "main", sender: SENDER, text: "5gb" })).json()).outcome).toBe("blocked")
  })

  it("logs neither the text nor the number", async () => {
    await post({ line: "main", sender: SENDER, text: "5gb to someone" })
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    expect(logged).not.toContain(SENDER)
    expect(logged).not.toContain("someone")
  })

  it("a failure inside the lane is contained by processInbound: outcome error, and nothing is logged with the number", async () => {
    h.resolve.mockRejectedValue(new Error("boom 0200000101"))
    const res = await post({ line: "main", sender: SENDER, text: "5gb" })
    // processInbound contains its own errors and reports outcome "error"; the route still answers 200 with that outcome.
    expect(res.status).toBe(200)
    expect((await res.json()).outcome).toBe("error")
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain("0200000101")
  })
})
