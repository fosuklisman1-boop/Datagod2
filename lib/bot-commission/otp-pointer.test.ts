import { describe, it, expect, vi } from "vitest"
import { BOT_OTP_POINTER_TTL_SECONDS, botOtpPointerKey, createBotOtpPointerStore, type BotOtpPointer } from "./otp-pointer"

const P: BotOtpPointer = { reference: "a".repeat(32), orderType: "cs_bundle", orderId: "d1", createdAt: "2026-10-20T10:00:00.000Z" }

function fakeRedis() {
  const data = new Map<string, unknown>()
  const ttls = new Map<string, number>()
  return {
    data, ttls,
    setex: vi.fn(async (k: string, ttl: number, v: string) => { data.set(k, JSON.parse(v)); ttls.set(k, ttl); return "OK" }),
    // Upstash auto-deserialises JSON values.
    get: vi.fn(async (k: string) => (data.has(k) ? data.get(k) : null)),
    del: vi.fn(async (k: string) => { const had = data.delete(k); return had ? 1 : 0 }),
  }
}

describe("bot OTP pointer", () => {
  it("keys by the normalised local phone", () => {
    expect(botOtpPointerKey("233241234567")).toBe("ussd-bot-otp:0241234567")
    expect(botOtpPointerKey("+233 24 123 4567")).toBe("ussd-bot-otp:0241234567")
    expect(botOtpPointerKey("0241234567")).toBe("ussd-bot-otp:0241234567")
    expect(botOtpPointerKey("12")).toBeNull()
  })

  it("set / peek / clear through Redis with a 10-minute TTL; any phone format finds it", async () => {
    const r = fakeRedis()
    const s = createBotOtpPointerStore(() => r as any)
    await s.set("233241234567", P)
    expect(BOT_OTP_POINTER_TTL_SECONDS).toBe(600)
    expect(r.ttls.get("ussd-bot-otp:0241234567")).toBe(600)
    expect(await s.peek("0241234567")).toEqual({ ...P, phone: "0241234567" })
    expect(await s.peek("0201234567")).toBeNull()
    await s.clear("+233241234567")
    expect(await s.peek("0241234567")).toBeNull()
  })

  it("an invalid phone is a no-op", async () => {
    const r = fakeRedis()
    const s = createBotOtpPointerStore(() => r as any)
    await s.set("abc", P)
    expect(r.setex).not.toHaveBeenCalled()
    expect(await s.peek("abc")).toBeNull()
  })

  it("ignores a malformed stored value", async () => {
    const r = fakeRedis()
    r.data.set("ussd-bot-otp:0241234567", { reference: 5 })
    const s = createBotOtpPointerStore(() => r as any)
    expect(await s.peek("0241234567")).toBeNull()
  })

  it("WhatsApp pointers live in their own key space (wa-bot-otp:<0X>); Uzo keys are unchanged", () => {
    expect(botOtpPointerKey("233241234567", "whatsapp")).toBe("wa-bot-otp:0241234567")
    expect(botOtpPointerKey("233241234567", "ussd")).toBe("ussd-bot-otp:0241234567")
    expect(botOtpPointerKey("12", "whatsapp")).toBeNull()
  })

  it("a WhatsApp pointer is set / peeked / cleared only through the whatsapp channel", async () => {
    const r = fakeRedis()
    const s = createBotOtpPointerStore(() => r as any)
    const W: BotOtpPointer = { ...P, orderId: "w1", channel: "whatsapp" }
    await s.set("233241234567", W)
    expect([...r.data.keys()]).toEqual(["wa-bot-otp:0241234567"])
    expect(r.ttls.get("wa-bot-otp:0241234567")).toBe(600)
    expect(await s.peek("0241234567")).toBeNull() // the Uzo redial never sees it
    expect(await s.peek("0241234567", "whatsapp")).toEqual({ ...W, phone: "0241234567" })
    // a Uzo pointer for the same number coexists and stays Uzo-only
    await s.set("0241234567", P)
    expect(r.data.get("ussd-bot-otp:0241234567")).toEqual({ ...P, phone: "0241234567" }) // stored exactly as before (no channel field)
    expect(await s.peek("0241234567", "whatsapp")).toMatchObject({ orderId: "w1" })
    expect(await s.peek("0241234567")).toMatchObject({ orderId: "d1" })
    await s.clear("0241234567", "whatsapp")
    expect(await s.peek("0241234567", "whatsapp")).toBeNull()
    expect(await s.peek("0241234567")).toMatchObject({ orderId: "d1" })
    await s.clear("0241234567")
    expect(r.data.size).toBe(0)
  })

  it("a value whose channel does not match its key space is ignored", async () => {
    const r = fakeRedis()
    r.data.set("ussd-bot-otp:0241234567", { ...P, phone: "0241234567", channel: "whatsapp" })
    r.data.set("wa-bot-otp:0241234567", { ...P, phone: "0241234567" })
    const s = createBotOtpPointerStore(() => r as any)
    expect(await s.peek("0241234567")).toBeNull()
    expect(await s.peek("0241234567", "whatsapp")).toBeNull()
  })

  it("the WhatsApp shop bot has its own key space (wa-shop-bot-otp:<0X>); main WhatsApp and Uzo keys are unchanged", () => {
    expect(botOtpPointerKey("233241234567", "whatsapp_shop")).toBe("wa-shop-bot-otp:0241234567")
    expect(botOtpPointerKey("233241234567", "whatsapp")).toBe("wa-bot-otp:0241234567")
    expect(botOtpPointerKey("233241234567")).toBe("ussd-bot-otp:0241234567")
    expect(botOtpPointerKey("12", "whatsapp_shop")).toBeNull()
  })

  it("a shop-bot pointer never overwrites (or is seen as) the main bot's pointer for the same sender", async () => {
    const r = fakeRedis()
    const s = createBotOtpPointerStore(() => r as any)
    const MAIN: BotOtpPointer = { ...P, orderId: "main-1", channel: "whatsapp" }
    const SHOP: BotOtpPointer = { ...P, orderId: "shop-1", channel: "whatsapp_shop" }
    await s.set("233241234567", MAIN)
    await s.set("233241234567", SHOP)
    expect([...r.data.keys()].sort()).toEqual(["wa-bot-otp:0241234567", "wa-shop-bot-otp:0241234567"])
    expect(r.ttls.get("wa-shop-bot-otp:0241234567")).toBe(600)
    expect(await s.peek("0241234567", "whatsapp")).toMatchObject({ orderId: "main-1", channel: "whatsapp" })
    expect(await s.peek("0241234567", "whatsapp_shop")).toEqual({ ...SHOP, phone: "0241234567" })
    expect(await s.peek("0241234567")).toBeNull()
    await s.clear("0241234567", "whatsapp_shop")
    expect(await s.peek("0241234567", "whatsapp_shop")).toBeNull()
    expect(await s.peek("0241234567", "whatsapp")).toMatchObject({ orderId: "main-1" })
  })

  it("a main-bot value stored under the shop key (or the reverse) is ignored", async () => {
    const r = fakeRedis()
    r.data.set("wa-shop-bot-otp:0241234567", { ...P, phone: "0241234567", channel: "whatsapp" })
    r.data.set("wa-bot-otp:0241234567", { ...P, phone: "0241234567", channel: "whatsapp_shop" })
    const s = createBotOtpPointerStore(() => r as any)
    expect(await s.peek("0241234567", "whatsapp_shop")).toBeNull()
    expect(await s.peek("0241234567", "whatsapp")).toBeNull()
  })

  it("memory fallback keeps the channels apart too", async () => {
    const s = createBotOtpPointerStore(() => null, () => 1_000)
    await s.set("0241234567", { ...P, channel: "whatsapp" })
    expect(await s.peek("0241234567")).toBeNull()
    expect(await s.peek("0241234567", "whatsapp")).toMatchObject({ channel: "whatsapp" })
  })

  it("falls back to memory (with expiry) when Redis is not configured or errors", async () => {
    let t = 1_000_000
    const s = createBotOtpPointerStore(() => null, () => t)
    await s.set("0241234567", P)
    expect(await s.peek("233241234567")).toMatchObject({ reference: P.reference })
    t += 601_000
    expect(await s.peek("0241234567")).toBeNull()

    const broken = { setex: vi.fn(async () => { throw new Error("down") }), get: vi.fn(async () => { throw new Error("down") }), del: vi.fn(async () => { throw new Error("down") }) }
    const s2 = createBotOtpPointerStore(() => broken as any, () => t)
    await s2.set("0241234567", P)
    expect(await s2.peek("0241234567")).toMatchObject({ orderId: "d1" })
    await s2.clear("0241234567")
    expect(await s2.peek("0241234567")).toBeNull()
  })
})
