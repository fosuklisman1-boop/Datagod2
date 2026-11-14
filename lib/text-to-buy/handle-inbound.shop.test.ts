import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { calculateSegments } from "@/lib/sms/segments"
import { makeFakeTtb } from "./fake-db.test-helper"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import type { ReadResult } from "./types"
import { notUnderstoodReply } from "./replies"

/** The shop line in the lane (Stage 3a, task 9): resolve, closed/paused, reserve-before-place, payers, wrong line, retries. */

const h = vi.hoisted(() => ({
  map: { MTN: ["20", "24"], TELECEL: [] as string[], AT: [] as string[] },
  surface: vi.fn(),
  payer: vi.fn(),
  notify: vi.fn(),
}))

vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: true, map: h.map })) }))
vi.mock("@/lib/payment-gateway/start", () => ({ resolveSurfaceGateway: h.surface }))
vi.mock("@/lib/ussd/gateway-charge", () => ({ isUssdHubtelPayer: h.payer }))
vi.mock("@/lib/ussd/handlers/bundles", () => ({ handleConfirm: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), notifyAdmins: h.notify }))
vi.mock("./catalogue", () => {
  const parse = (s: string) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb)?\s*$/i.exec(s)
    return m ? { n: Number(m[1]), unit: m[2]?.toLowerCase() === "mb" ? "MB" : "GB" } : null
  }
  return {
    resolveOffer: vi.fn(),
    listPrices: vi.fn(),
    parseSizeMb: (s: string) => {
      const p = parse(s)
      return p ? Math.round(p.unit === "GB" ? p.n * 1000 : p.n) : null
    },
    sizeLabel: (s: string) => {
      const p = parse(s)
      return p ? `${p.n}${p.unit}` : s
    },
    sessionForOffer: (sender: string, o: { network: string; bundleId: string; size: string; price: number; recipientLocal: string }) => ({
      dialingPhone: "+233" + sender.slice(1), network: o.network, bundleId: o.bundleId, bundleSize: o.size, bundlePrice: o.price, recipientPhone: o.recipientLocal,
    }),
  }
})

import { acceptInbound, processInbound, resetReplyCapAlert, type InboundDeps, type InboundInput } from "./handle-inbound"

const S = "0240000101" // the texting number (MTN prefix in the fake map)
const R = "0240000150"
const ORDER = "6f0c1a9e-0163-4163-8163-0000000000c1"
const now = new Date("2026-11-14T12:00:00Z")
const DAY = "2026-11-14"
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)
const SHOP_NUMBER = "0200000999"
const settings = (over: Partial<TtbSettings> = {}): TtbSettings => ({ ...TTB_DEFAULTS, mainEnabled: true, shopEnabled: true, shopNumber: SHOP_NUMBER, ...over })
const order5: ReadResult = { kind: "order", service: "data", sizeMb: 5000, networkHint: null, recipient: null, bare: false }

type Resolved = { shopCodeId: string; shopId: string; shopName: string; parentShopId: string | null; status: string; tokenBalance: number; whatsappActivated: boolean; ownerPhone: string | null }
const shopRow = (over: Partial<Resolved> = {}): Resolved => ({
  shopCodeId: "sc1", shopId: "shop1", shopName: "Ama Data Hub", parentShopId: null, status: "active", tokenBalance: 0, whatsappActivated: false, ownerPhone: "0241234567", ...over,
})

function setup(opts: { seed?: Record<string, Record<string, unknown>[]>; codes?: Record<string, Resolved>; pref?: string | null } = {}) {
  const f = makeFakeTtb(opts.seed ?? {})
  f.db.rpcImpl = (name) => (name === "ttb_counts" ? { data: [{ prompts_unpaid: 0, replies: 0, ai_reads: 0, not_understood: 0 }], error: null } : { data: 0, error: null })
  const c = f.client as unknown as SupabaseClient
  const codes: Record<string, Resolved> = opts.codes ?? { K7X9: shopRow() }
  const byId = () => Object.values(codes)
  const prefs = { id: opts.pref === undefined ? null : opts.pref }
  const resolveDeps = {
    resolveShopCode: vi.fn(async (code: string) => codes[code] ?? null),
    getShopPref: vi.fn(async () => (prefs.id ? { shopCodeId: prefs.id } : null)),
    setShopPref: vi.fn(async (_s: string, id: string) => {
      prefs.id = id
    }),
    lastBoughtShopCodeId: vi.fn(async () => null),
    shopCodeById: vi.fn(async (id: string) => byId().find((r) => r.shopCodeId === id) ?? null),
  }
  const shopData = {
    shopPrices: vi.fn(async (_s: unknown, product: string) => (product === "MTN" ? [{ id: "b5", size: "5", price: 23.5 }] : [])),
    verifyPrice: vi.fn(async () => ({ verifiedPrice: 23.5 })),
    carrierOf: vi.fn(async () => "MTN" as const),
    confirmShop: vi.fn(async (_a: unknown) => ({ orderId: ORDER as string | undefined, amountGhs: 23.5 })),
    dataVisible: vi.fn(async () => true),
  }
  const credits = {
    accountFor: vi.fn(async () => ({ accountId: "acct1" }) as { accountId: string } | null),
    reserve: vi.fn(async (_db: unknown, _a: unknown) => ({ ok: true }) as { ok: true } | { ok: false; reason: "no_account" | "inactive" | "insufficient" }),
    release: vi.fn(async (_db: unknown, _messageId: string) => 2),
    capReached: vi.fn(async () => false),
  }
  const deps = {
    readAi: vi.fn(async (text: string, _history: { role: string; text: string }[]) => (/5gb/i.test(text) ? order5 : ({ kind: "not_order" } as ReadResult))),
    reply: vi.fn(async (_db: unknown, _r: Record<string, unknown>) => ({ sent: true }) as { sent: boolean; skipped?: boolean | "unpaid" }),
    alert: vi.fn(async (_message: string) => {}),
    feeOnTop: vi.fn(async () => false),
    shop: { resolve: resolveDeps, shopData, credits },
  }
  let n = 0
  async function run(text: string, over: { input?: Partial<InboundInput>; settings?: Partial<TtbSettings>; deps?: Partial<InboundDeps> } = {}) {
    n += 1
    const input: InboundInput = { line: "shop", from: S, text, receivedAt: null, now: new Date(now.getTime() + n), ...over.input }
    const { id } = await acceptInbound(c, input)
    const result = await processInbound(c, id, input, settings(over.settings), { ...deps, ...over.deps } as unknown as InboundDeps)
    return { result, id, input }
  }
  const replyArgs = () => deps.reply.mock.calls.map((x) => x[1])
  return { f, c, codes, prefs, resolveDeps, shopData, credits, deps, run, replyArgs }
}

beforeEach(() => {
  h.map = { MTN: ["20", "24"], TELECEL: [], AT: [] }
  h.surface.mockReset()
  h.payer.mockReset()
  h.notify.mockReset()
  resetReplyCapAlert()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("shop line: gate", () => {
  it("the shop switch off: outcome off, nothing read, placed or sent", async () => {
    const t = setup({ pref: "sc1" })
    const { result } = await t.run("5gb", { settings: { shopEnabled: false } })
    expect(result.outcome).toBe("off")
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
    expect(t.credits.reserve).not.toHaveBeenCalled()
  })

  it("the main switch off does not gate the shop line", async () => {
    const t = setup({ pref: "sc1" })
    const { result } = await t.run("5gb", { settings: { mainEnabled: false } })
    expect(result.outcome).toBe("prompted")
  })
})

describe("shop line: resolution", () => {
  it("a closed shop gets the closed copy once per sender per shop per day, Datagod-paid; the second text is silent; no order", async () => {
    const t = setup({ codes: { K7X9: shopRow({ status: "inactive" }) } })
    const first = await t.run("K7X9 5gb")
    expect(first.result.reply).toBe("Ama Data Hub can't take text orders right now. Call 0241234567.")
    expect(calculateSegments(first.result.reply!)).toMatchObject({ encoding: "gsm7", segments: 1 })
    expect(t.replyArgs()[0].payer).toBeUndefined()
    const second = await t.run("K7X9 5gb please")
    expect(second.result.reply).toBeNull()
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
    expect(t.credits.reserve).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_notices).toMatchObject([{ kind: "closed", sender: S, shop_id: "shop1", day: DAY }])
  })

  it("a closed shop without a helpline omits the Call part", async () => {
    const t = setup({ codes: { K7X9: shopRow({ status: "suspended", ownerPhone: null }) } })
    const { result } = await t.run("K7X9 5gb")
    expect(result.reply).toBe("Ama Data Hub can't take text orders right now.")
  })

  it("an unknown strong code replies shop not found, Datagod-paid, no fallback to another shop, no order", async () => {
    const t = setup({ pref: "sc1" })
    const { result } = await t.run("ZZ99 5gb")
    expect(result.reply).toMatch(/shop not found/i)
    expect(t.replyArgs()[0].payer).toBeUndefined()
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
    expect(t.credits.reserve).not.toHaveBeenCalled()
  })

  it("no code, no memory: asks Which shop? (Datagod-paid) and holds the read for 20 minutes", async () => {
    const t = setup()
    const { result } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "asked", reply: "Which shop? Reply with the shop code" })
    expect(t.replyArgs()[0].payer).toBeUndefined()
    expect(t.f.db.tables.ttb_conversations[0]).toMatchObject({ line: "shop", sender: S, pending: { type: "shop", read: { kind: "order", sizeMb: 5000 } } })
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
  })

  it("300 shop-paid replies in the hour never silence a Datagod-paid reply (the global cap counts Datagod-paid rows only)", async () => {
    const paid = Array.from({ length: 300 }, (_, k) => ({
      id: `sp${k}`, line: "shop", sender: `02000${String(k).padStart(5, "0")}`, direction: "out", body: "x", created_at: new Date(now.getTime() - 60_000).toISOString(), shop_id: "shop1",
    }))
    const t = setup({ seed: { ttb_messages: paid } })
    const { result } = await t.run("5gb", { settings: { globalRepliesPerHour: 300 } })
    expect(result).toMatchObject({ outcome: "asked", reply: "Which shop? Reply with the shop code" })
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
  })

  it("answering the question with a code completes the held read (no AI read, order placed for that shop)", async () => {
    const t = setup()
    await t.run("5gb")
    t.deps.readAi.mockClear()
    const { result } = await t.run("K7X9")
    expect(t.deps.readAi).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "prompted", orderId: ORDER })
    expect(t.shopData.confirmShop).toHaveBeenCalledTimes(1)
    expect(t.shopData.confirmShop.mock.calls[0][0]).toMatchObject({ shopCodeId: "sc1", shopId: "shop1", recipientLocal: S })
  })

  it("a stale shop pending (older than 20 minutes) forgets: a bare code then places nothing", async () => {
    const t = setup({
      seed: { ttb_conversations: [{ line: "shop", sender: S, turns: [], pending: { type: "shop", read: order5 }, last_order: null, expires_at: minutesAgo(30).toISOString() }] },
    })
    const { result } = await t.run("K7X9")
    expect(result.outcome).toBe("not_order")
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
    expect(t.credits.reserve).not.toHaveBeenCalled()
  })

  it("a bare 4-digit size the read used is never taken for a shop code (excludeTokens)", async () => {
    const t = setup()
    t.deps.readAi.mockResolvedValue({ kind: "order", service: "data", sizeMb: 1000, networkHint: null, recipient: null, bare: true })
    const { result } = await t.run("buy 1000 pls")
    // Not a strong candidate, so it can never turn into "shop not found"; with no real shop of that code the customer is asked.
    expect(result).toMatchObject({ outcome: "asked", reply: "Which shop? Reply with the shop code" })
  })

  it("tries at most 5 candidates per text", async () => {
    const t = setup()
    await t.run("A1B2 C3D4 E5F6 G7H8 I9J1 K2L3 M4N5 O6P7 5gb")
    expect(t.resolveDeps.resolveShopCode.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it("a new valid code switches the remembered shop", async () => {
    const t = setup({ pref: "sc2", codes: { K7X9: shopRow(), Q2W3: shopRow({ shopCodeId: "sc2", shopId: "shop2", shopName: "Kofi Bundles" }) } })
    await t.run("K7X9 5gb")
    expect(t.resolveDeps.setShopPref).toHaveBeenCalledWith(S, "sc1")
    expect(t.shopData.confirmShop.mock.calls[0][0]).toMatchObject({ shopId: "shop1" })
  })
})

describe("shop line: credits", () => {
  it("reserves 2 credits exactly once for an own-number order, before place, and the quote names the shop", async () => {
    const t = setup({ pref: "sc1" })
    const order: string[] = []
    t.credits.reserve.mockImplementation(async () => (order.push("reserve"), { ok: true as const }))
    t.shopData.confirmShop.mockImplementation(async () => (order.push("place"), { orderId: ORDER, amountGhs: 23.5 }))
    const { result, id } = await t.run("5gb")
    expect(order).toEqual(["reserve", "place"])
    expect(t.credits.reserve).toHaveBeenCalledTimes(1)
    expect(t.credits.reserve.mock.calls[0][1]).toEqual({ accountId: "acct1", shopId: "shop1", messageId: id, credits: 2 })
    expect(result.outcome).toBe("prompted")
    expect(result.reply).toContain("Ama Data Hub")
    const link = t.f.db.tables.ttb_orders[0]
    expect(link).toMatchObject({ line: "shop", sender: S, order_table: "ussd_shop_orders", order_id: ORDER, shop_id: "shop1", gift: false, amount: 23.5 })
    expect(t.f.db.tables.ttb_conversations[0].last_order).toMatchObject({ sizeMb: 5000, network: "MTN", recipient: S, shopCodeId: "sc1" })
    expect(t.resolveDeps.setShopPref).toHaveBeenCalledWith(S, "sc1")
    // the quote is paid by the shop, from the order's reserve
    const quote = t.replyArgs().find((r) => r.body === result.reply)!
    expect(quote.payer).toMatchObject({ kind: "shop", shopId: "shop1", accountId: "acct1", messageId: id })
    expect(String((quote.payer as { replyKey: string }).replyKey)).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
  })

  it("reserves 3 credits for a gift", async () => {
    const t = setup({ pref: "sc1" })
    await t.run(`5gb ${"0241112222"}`)
    expect(t.credits.reserve.mock.calls[0][1]).toMatchObject({ credits: 3 })
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ gift: true })
  })

  it("the idempotency pre-write comes after the reserve and immediately before place", async () => {
    const t = setup({ pref: "sc1" })
    const order: string[] = []
    t.credits.reserve.mockImplementation(async () => (order.push("reserve"), { ok: true as const }))
    t.shopData.confirmShop.mockImplementation(async () => {
      const m = t.f.db.tables.ttb_messages.find((x) => x.direction === "in")!
      order.push(`place:${String(m.outcome)}`)
      return { orderId: ORDER, amountGhs: 23.5 }
    })
    await t.run("5gb")
    expect(order).toEqual(["reserve", "place:error"])
  })

  it.each([
    ["no account", { account: null as { accountId: string } | null }],
    ["inactive", { reserve: { ok: false as const, reason: "inactive" as const } }],
    ["insufficient credits", { reserve: { ok: false as const, reason: "insufficient" as const } }],
  ])("a shop with %s is paused: nothing placed or prompted, one Datagod-paid pause reply per day, one owner alert", async (_n, how) => {
    const t = setup({ pref: "sc1" })
    if ("account" in how) t.credits.accountFor.mockResolvedValue(how.account)
    if ("reserve" in how) t.credits.reserve.mockResolvedValue(how.reserve)
    const first = await t.run("5gb")
    expect(first.result.reply).toBe("Ama Data Hub can't take text orders right now. Call 0241234567.")
    expect(t.replyArgs()[0].payer).toBeUndefined()
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
    const second = await t.run("5gb now")
    expect(second.result.reply).toBeNull()
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    expect(String(t.deps.alert.mock.calls[0][0])).not.toContain(S)
  })

  it("a place that yields no orderId releases the reserve at once and links nothing", async () => {
    const t = setup({ pref: "sc1" })
    t.shopData.confirmShop.mockResolvedValue({ orderId: undefined, amountGhs: 23.5 })
    const { result, id } = await t.run("5gb")
    expect(result.outcome).toBe("unavailable")
    expect(t.credits.release).toHaveBeenCalledTimes(1)
    expect(t.credits.release.mock.calls[0][1]).toBe(id)
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("a shop whose status flipped between resolve and place does not place and reserves nothing", async () => {
    const t = setup({ pref: "sc1" })
    const open = shopRow()
    t.resolveDeps.shopCodeById.mockResolvedValueOnce(open).mockResolvedValue({ ...open, status: "suspended" })
    const { result } = await t.run("5gb")
    expect(result.reply).toContain("can't take text orders right now")
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
    expect(t.credits.reserve).not.toHaveBeenCalled()
  })

  it("over the per-shop reply cap the reply is silent: no order, no reserve, no Datagod fallback", async () => {
    const t = setup({ pref: "sc1" })
    t.credits.capReached.mockResolvedValue(true)
    const { result } = await t.run("5gb")
    expect(result.reply).toBeNull()
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.credits.reserve).not.toHaveBeenCalled()
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
  })

  it("a shop-paid reply that comes back unpaid is not resent by Datagod and nothing more is sent", async () => {
    const t = setup({ pref: "sc1" })
    t.deps.reply.mockResolvedValue({ sent: false, skipped: "unpaid" })
    await t.run("5gb")
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(t.replyArgs()[0].payer).toMatchObject({ kind: "shop" })
  })

  it("replies inside the shop context are shop-paid, each with its own replyKey", async () => {
    const t = setup({ pref: "sc1" })
    t.shopData.shopPrices.mockResolvedValue([]) // the shop sells nothing: a refusal that names the shop
    await t.run("5gb")
    await t.run("5gb again please")
    const keys = t.replyArgs().map((r) => (r.payer as { replyKey: string }).replyKey)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    for (const r of t.replyArgs()) expect(r.payer).toMatchObject({ kind: "shop", shopId: "shop1", accountId: "acct1" })
  })
})

describe("shop line: the same message twice", () => {
  it("never creates two orders or two reserves", async () => {
    const t = setup({ pref: "sc1" })
    const { id, input } = await t.run("5gb")
    const again = await processInbound(t.c, id, input, settings(), t.deps as unknown as InboundDeps)
    expect(again.outcome).toBe("duplicate")
    expect(t.credits.reserve).toHaveBeenCalledTimes(1)
    expect(t.shopData.confirmShop).toHaveBeenCalledTimes(1)
    expect(t.f.db.tables.ttb_orders).toHaveLength(1)
  })
})

describe("shop line: retries and open orders", () => {
  const seedLast = (shopCodeId: string) => ({
    ttb_conversations: [{ line: "shop", sender: S, turns: [], pending: null, last_order: { sizeMb: 5000, network: "MTN", recipient: S, shopCodeId }, expires_at: minutesAgo(30).toISOString() }],
  })

  it("AGAIN re-resolves the shop of the last order (not the remembered one) and takes a fresh reserve", async () => {
    const t = setup({
      pref: "sc1",
      seed: seedLast("sc2"),
      codes: { K7X9: shopRow(), Q2W3: shopRow({ shopCodeId: "sc2", shopId: "shop2", shopName: "Kofi Bundles" }) },
    })
    const { result } = await t.run("again")
    expect(result.outcome).toBe("prompted")
    expect(t.shopData.confirmShop.mock.calls[0][0]).toMatchObject({ shopCodeId: "sc2", shopId: "shop2" })
    expect(t.credits.reserve.mock.calls[0][1]).toMatchObject({ shopId: "shop2", credits: 2 })
    expect(result.reply).toContain("Kofi Bundles")
  })

  it("AGAIN for a shop that is now closed gets the closed copy and places nothing", async () => {
    const t = setup({ seed: seedLast("sc2"), codes: { Q2W3: shopRow({ shopCodeId: "sc2", shopId: "shop2", shopName: "Kofi Bundles", status: "suspended" }) } })
    const { result } = await t.run("again")
    expect(result.reply).toContain("Kofi Bundles can't take text orders right now")
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
  })

  it("AGAIN with a last order that names no shop asks Which shop? (never guesses)", async () => {
    const t = setup({
      pref: "sc1",
      seed: { ttb_conversations: [{ line: "shop", sender: S, turns: [], pending: null, last_order: { sizeMb: 5000, network: "MTN", recipient: S }, expires_at: minutesAgo(30).toISOString() }] },
    })
    const { result } = await t.run("again")
    expect(result.reply).toBe("Which shop? Reply with the shop code")
  })

  it("an open MAIN order does not block a shop order (one open order per line and sender)", async () => {
    const t = setup({
      pref: "sc1",
      seed: { ttb_orders: [{ id: "o1", line: "main", sender: S, service: "data", order_table: "ussd_orders", order_id: "main-1", state: "awaiting_payment", size: "5", recipient: S, gift: false, amount: 20, notices: [], created_at: now.toISOString() }] },
    })
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("prompted")
  })

  it("an open SHOP order blocks a second shop order", async () => {
    const t = setup({ pref: "sc1" })
    await t.run("5gb")
    const second = await t.run("5gb thanks")
    expect(second.result.outcome).toBe("open_order")
    expect(t.shopData.confirmShop).toHaveBeenCalledTimes(1)
    expect(t.credits.reserve).toHaveBeenCalledTimes(1)
  })
})

describe("shop line: services", () => {
  it("an airtime text on the shop line behaves as if airtime were off (never placed, never offered)", async () => {
    const t = setup({ pref: "sc1" })
    const { result } = await t.run("airtime 10", { settings: { airtimeEnabled: true, resultsCheckerEnabled: true } })
    expect(result.outcome).toBe("not_order")
    expect(result.reply).toBe(notUnderstoodReply({}))
    expect(t.credits.reserve).not.toHaveBeenCalled()
    expect(t.shopData.confirmShop).not.toHaveBeenCalled()
  })

  it("PRICES on the shop line never shows the main catalogue", async () => {
    const t = setup({ pref: "sc1" })
    const prices = vi.fn(async () => ({ networkLabel: "MTN", items: [{ size: "1GB", priceGhs: 5 }] }))
    const { result } = await t.run("prices", { deps: { prices } as Partial<InboundDeps> })
    expect(prices).not.toHaveBeenCalled()
    expect(result.reply).not.toContain("GHS")
  })
})

describe("main line: wrong-line notice", () => {
  const main = (over: Partial<TtbSettings> = {}) => ({ input: { line: "main" as const }, settings: over })

  it("a text naming an active shop's code gets 'For shop orders text <shop number>' once per sender per day, Datagod-paid, no order", async () => {
    const t = setup()
    const first = await t.run("shop K7X9", main())
    expect(first.result.reply).toBe(`For shop orders text ${SHOP_NUMBER}`)
    expect(t.replyArgs()[0].payer).toBeUndefined()
    const second = await t.run("K7X9 please", main())
    expect(second.result.reply).toBeNull()
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(t.f.db.tables.ttb_notices).toMatchObject([{ kind: "wrong_line", sender: S, shop_id: null, day: DAY }])
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("only when a shop number is set: otherwise the normal main reply and no shop lookup", async () => {
    const t = setup()
    const { result } = await t.run("shop K7X9", main({ shopNumber: "" }))
    expect(t.resolveDeps.resolveShopCode).not.toHaveBeenCalled()
    expect(result.reply).toBe(notUnderstoodReply({}))
  })

  it("a closed shop's code on the main line gets the normal main reply", async () => {
    const t = setup({ codes: { K7X9: shopRow({ status: "inactive" }) } })
    const { result } = await t.run("shop K7X9", main())
    expect(result.reply).toBe(notUnderstoodReply({}))
  })

  it("a text the main lane reads as a data order is placed there, not redirected", async () => {
    const t = setup()
    const confirm = vi.fn(async () => ({ type: "end", message: "", orderId: ORDER, amount: 23.69 }))
    const resolve = vi.fn(async () => ({
      ok: true as const,
      offer: { network: "MTN", networkLabel: "MTN", bundleId: "b5", size: "5", price: 23.69, recipientLocal: S, gift: false, tier: { effectivePriceTier: "customer", subAgentParentShopId: null, userId: null, mtnWhitelistActive: false }, paystackProvider: "mtn" },
    }))
    const { result } = await t.run("5gb", { ...main(), deps: { confirm, resolve } as unknown as Partial<InboundDeps> })
    expect(result.outcome).toBe("prompted")
    expect(t.resolveDeps.resolveShopCode).not.toHaveBeenCalled()
  })
})
