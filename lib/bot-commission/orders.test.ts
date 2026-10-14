import { describe, it, expect, beforeEach } from "vitest"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import { resolveBillsConfig } from "@/lib/bills/config"
import { resolveBundlesConfig } from "@/lib/standard-bundles/config"
import { __resetCatalogCache } from "@/lib/standard-bundles/catalog"
import { botBillerAllowed, botBinding, resolveBotContext, type BotContext } from "./context"
import { botVerifyBill } from "./verify"
import { botCatalog } from "./catalog"
import {
  botCreateBillOrder, botCreateBundleOrder,
  type BotBillInsert, type BotBillsDeps, type BotBundleInsert, type BotBundlesDeps, type BotOrderRow,
} from "./orders"
import { TOO_MANY_REQUESTS, type BotCapDeps } from "./caps"

const NOW = 1_700_000_000_000
const SHOP = "11111111-2222-4333-8444-555555555555"
const MAIN: BotContext = { botSurface: "whatsapp", rail: "paystack", buyerPhone: "0241234567" }
const SHOPBOT: BotContext = { botSurface: "ussd_shop", shopId: SHOP, rail: "hubtel", buyerPhone: "+233 24 123 4567" }

const CASHBACK = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
  enabled: true,
  surfaces: { bots: true },
  rates: { "data_mtn:hubtel": 3.96, "bill_dstv:hubtel": 3.96, "bill_ghana_water:hubtel": 1 },
  shares: {
    bundles: { customer: 25, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 },
    bills: { customer: 25, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 },
  },
  botGroups: { bills: true, bundles: true },
  botFees: { paystack: { bills: 1.95, bundles: 1.95 }, hubtel: { bills: 1, bundles: 1 } },
  ...over,
})

/** Fake caps: records every limiter call; `block` names a limiter that says no; `pending` gives DB counts. */
function fakeCaps(opts: { block?: string; pending?: Partial<Record<"buyer_phone" | "shop_id", number>> } = {}) {
  const limits: { name: string; max: number; windowMs: number; id: string }[] = []
  const counts: { table: string; column: string; value: string }[] = []
  const caps: BotCapDeps = {
    limit: async (name, max, windowMs, id) => (limits.push({ name, max, windowMs, id }), name !== opts.block),
    countPending: async (table, column, value) => (counts.push({ table, column, value }), opts.pending?.[column] ?? 0),
    now: () => NOW,
  }
  return { caps, limits, counts }
}

// ───────────────────────── bills harness ─────────────────────────

function billsHarness(over: Partial<BotBillsDeps> & { cashback?: any; hubtel?: any; bills?: any } = {}) {
  const { caps, limits, counts } = fakeCaps()
  const inserts: BotBillInsert[] = []
  const saved: (BotOrderRow & { bot_surface: string; buyer_phone: string; verify_token_hash: string })[] = []
  let refs = 0
  const d: BotBillsDeps = {
    getCashbackConfig: async () => over.cashback ?? CASHBACK(),
    getBuyerTier: async () => "customer",
    getBillsConfig: async () => resolveBillsConfig(over.bills ?? {
      enabled: true,
      billers: { dstv: { enabled: true, min: 5, max: 1000 }, ghana_water: { enabled: true, min: 5, max: 1000 } },
    }),
    getHubtelConfig: async () => over.hubtel ?? { enabled: true, paused: false, services: { bill_dstv: true, bill_ghana_water: true } },
    query: async () => ({
      ok: true,
      data: [{ Display: "name", Value: "JOHN DOE" }, { Display: "amountDue", Value: "80" }, { Display: "sessionId", Value: "S-1" }] as any,
    }),
    purchase: async () => { throw new Error("never in create") },
    insertOrder: async () => { throw new Error("dashboard insert must not be used") },
    getOrder: async () => null,
    updateOrder: async () => 0,
    debitOrder: async () => { throw new Error("never debits") },
    alert: async () => {},
    newReference: () => (refs++ === 0 ? "BILL-ABC123" : `BILL-ALT${refs}`),
    secret: "s3cret",
    now: () => NOW,
    async insertBotBillOrder(row) {
      if (saved.some(s => s.verify_token_hash === row.verify_token_hash || s.reference_code === row.reference_code)) {
        throw Object.assign(new Error("dup"), { code: "23505" })
      }
      inserts.push(row)
      const s = {
        id: `order-${inserts.length}`, reference_code: row.reference_code, amount: row.amount, paid_amount: row.paid_amount,
        payment_fee_amount: row.payment_fee_amount, cashback_amount: row.cashback_amount,
        bot_surface: row.bot_surface, buyer_phone: row.buyer_phone, verify_token_hash: row.verify_token_hash,
      }
      saved.push(s)
      return s
    },
    async findBotBillOrderByHash(surface, phone, hash) {
      return saved.find(s => s.bot_surface === surface && s.buyer_phone === phone && s.verify_token_hash === hash) ?? null
    },
    caps,
    ...over,
  }
  return { d, inserts, saved, limits, counts }
}

async function billToken(d: BotBillsDeps, ctx: BotContext) {
  const r = await botVerifyBill(d, ctx, { biller: "dstv", account: "1234567890" })
  if (!r.ok || !r.token) throw new Error("verify failed: " + JSON.stringify(r))
  return r.token
}

describe("resolveBotContext", () => {
  it("normalises the buyer phone to 233 form", () => {
    expect(resolveBotContext(SHOPBOT)).toEqual({
      ok: true, ctx: { botSurface: "ussd_shop", shopId: SHOP, rail: "hubtel", buyerPhone: "233241234567" },
    })
    expect(resolveBotContext(MAIN)).toMatchObject({ ok: true, ctx: { shopId: null, buyerPhone: "233241234567" } })
  })
  it.each([
    ["unknown surface", { ...MAIN, botSurface: "sms" }],
    ["unknown rail", { ...MAIN, rail: "moolre" }],
    ["bad phone", { ...MAIN, buyerPhone: "12345" }],
    ["shop bot without shop", { ...SHOPBOT, shopId: undefined }],
    ["main bot with shop", { ...MAIN, shopId: SHOP }],
    ["non-uuid shop", { ...SHOPBOT, shopId: "shop-A" }],
  ])("%s => 400", (_n, ctx) => {
    expect(resolveBotContext(ctx as any)).toMatchObject({ ok: false, status: 400 })
  })
  it("hubtel_ussd serves both menus", () => {
    expect(resolveBotContext({ botSurface: "hubtel_ussd", rail: "hubtel", buyerPhone: "0241234567" }).ok).toBe(true)
    expect(resolveBotContext({ botSurface: "hubtel_ussd", shopId: SHOP, rail: "hubtel", buyerPhone: "0241234567" }).ok).toBe(true)
  })
  it("binding and Ghana Water rule", () => {
    expect(botBinding({ botSurface: "whatsapp" })).toBe("bot:whatsapp:main")
    expect(botBinding({ botSurface: "ussd_shop", shopId: SHOP })).toBe(`bot:ussd_shop:${SHOP}`)
    for (const s of ["hubtel_ussd", "ussd", "ussd_shop"] as const) expect(botBillerAllowed(s, "ghana_water")).toBe(false)
    for (const s of ["whatsapp", "whatsapp_shop"] as const) expect(botBillerAllowed(s, "ghana_water")).toBe(true)
    expect(botBillerAllowed("ussd", "dstv")).toBe(true)
  })
})

describe("botVerifyBill", () => {
  it("masks names and binds the token to the bot + shop", async () => {
    const { d } = billsHarness()
    const r: any = await botVerifyBill(d, SHOPBOT, { biller: "dstv", account: "1234567890" })
    expect(r).toMatchObject({ ok: true, customerName: "JOH*** D***", amountDue: 80 })
    const body = JSON.parse(Buffer.from(r.token.split(".")[0], "base64url").toString())
    expect(body.userId).toBe(`bot:ussd_shop:${SHOP}`)
    expect(body.customerName).toBe("JOH*** D***")
    expect(JSON.stringify(r)).not.toContain("JOHN")
  })

  it.each(["hubtel_ussd", "ussd", "ussd_shop"] as const)("Ghana Water refused from %s (no lookup)", async surface => {
    let looked = false
    const { d } = billsHarness({ query: async () => { looked = true; return { ok: true, data: [] } } })
    const ctx: BotContext = { botSurface: surface, rail: "hubtel", buyerPhone: "0241234567", ...(surface === "ussd_shop" ? { shopId: SHOP } : {}) }
    const r = await botVerifyBill(d, ctx, { biller: "ghana_water", account: "1234567", phone: "0241234567", email: "a@b.co" })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(looked).toBe(false)
  })

  it("Ghana Water allowed from WhatsApp", async () => {
    const { d } = billsHarness()
    const r = await botVerifyBill(d, MAIN, { biller: "ghana_water", account: "1234567", phone: "0241234567", email: "a@b.co" })
    expect(r.ok).toBe(true)
  })

  it.each([
    ["bots group off", { cashback: CASHBACK({ botGroups: { bills: false } }) }, 403],
    ["bots surface off", { cashback: CASHBACK({ surfaces: { bots: false } }) }, 403],
    ["storefront on but bots off", { cashback: CASHBACK({ surfaces: { storefront: true, bots: false }, storefrontGroups: { bills: true } }) }, 403],
    ["hubtel paused", { hubtel: { enabled: true, paused: true, services: { bill_dstv: true } } }, 503],
  ])("%s => %i", async (_n, over, status) => {
    const { d } = billsHarness(over as any)
    expect(await botVerifyBill(d, MAIN, { biller: "dstv", account: "1234567890" })).toMatchObject({ ok: false, status })
  })

  it("a storefront-bound token is not a bot token", async () => {
    const { d } = billsHarness()
    const t = await billToken(d, MAIN)
    const other = await botCreateBillOrder(d, { botSurface: "whatsapp_shop", shopId: SHOP, rail: "paystack", buyerPhone: "0241234567" },
      { token: t, amount: 10, expectedPay: 10.11 })
    expect(other).toMatchObject({ ok: false, status: 400 })
  })
})

describe("botCreateBillOrder", () => {
  it("main bot: pending/unpaid bots row, no shop, no shop share, buyer in 233 form", async () => {
    const { d, inserts } = billsHarness()
    const token = await billToken(d, MAIN)
    // GHS 10 at 3.96 %, customer 25 % => cashback 0.09, base 9.91, paystack fee 1.95 % => 0.20, pay 10.11
    const r = await botCreateBillOrder(d, MAIN, { token, amount: "10", expectedPay: 10.11 })
    expect(r).toEqual({ ok: true, order: { id: "order-1", reference: "BILL-ABC123", payAmount: 10.11, faceAmount: 10, customerCashback: 0.09, paymentFee: 0.2 } })
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      channel: "bots", bot_surface: "whatsapp", shop_id: null, user_id: null, buyer_phone: "233241234567",
      buyer_email: null, buyer_name: null, amount: 10, paid_amount: 10.11, payment_fee_amount: 0.2,
      status: "pending", payment_status: "unpaid", cashback_amount: 0.09, shop_share_amount: 0, biller: "dstv",
      customer_name: "JOH*** D***",
    })
  })

  it("shop bot: shop_id + shop share snapshot, hubtel rail fee", async () => {
    const { d, inserts } = billsHarness()
    const token = await billToken(d, SHOPBOT)
    const r = await botCreateBillOrder(d, SHOPBOT, { token, amount: 10, expectedPay: 10.03 })
    expect(r).toMatchObject({ ok: true, order: { payAmount: 10.03, customerCashback: 0.07, paymentFee: 0.1 } })
    expect(inserts[0]).toMatchObject({ channel: "bots", bot_surface: "ussd_shop", shop_id: SHOP, shop_share_amount: 0.15 })
  })

  it("price drift => 409 with the live quote, nothing written", async () => {
    const { d, inserts } = billsHarness()
    const token = await billToken(d, MAIN)
    const r = await botCreateBillOrder(d, MAIN, { token, amount: 10, expectedPay: 10 })
    expect(r).toEqual({
      ok: false, status: 409, error: "Price updated — please review",
      quote: { faceAmount: 10, payAmount: 10.11, customerCashback: 0.09, paymentFee: 0.2 },
    })
    expect(inserts).toHaveLength(0)
  })

  it("same token retried => the same order, one row", async () => {
    const { d, inserts } = billsHarness()
    const token = await billToken(d, MAIN)
    const a = await botCreateBillOrder(d, MAIN, { token, amount: 10, expectedPay: 10.11 })
    const b = await botCreateBillOrder(d, MAIN, { token, amount: 10, expectedPay: 10.11 })
    expect(b).toEqual(a)
    expect(inserts).toHaveLength(1)
  })

  it("Ghana Water order refused server-side from a USSD bot even with a valid token", async () => {
    // A token minted for the USSD binding (as if a menu bypassed the verify refusal) still cannot create.
    const { signBillToken } = await import("@/lib/bills/token")
    const { d, inserts } = billsHarness()
    const ctx: BotContext = { botSurface: "ussd", rail: "hubtel", buyerPhone: "0241234567" }
    const token = signBillToken({
      userId: botBinding({ botSurface: "ussd" }), biller: "ghana_water", account: "1234567", phone: "233241234567",
      email: "a@b.co", broadbandAccount: null, sessionId: "S-1", customerName: null, verified: true, issuedAt: NOW,
    }, "s3cret")
    const r = await botCreateBillOrder(d, ctx, { token, amount: 10, expectedPay: 10 })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(inserts).toHaveLength(0)
  })

  it("gate off / missing expectedPay / bad amount", async () => {
    const h = billsHarness()
    const token = await billToken(h.d, MAIN)
    expect(await botCreateBillOrder(h.d, MAIN, { token, amount: 10, expectedPay: undefined })).toMatchObject({ status: 400 })
    expect(await botCreateBillOrder(h.d, MAIN, { token, amount: 1, expectedPay: 1 })).toMatchObject({ status: 400 })
    const off = billsHarness({ cashback: CASHBACK({ botGroups: { bills: false } }) })
    expect(await botCreateBillOrder(off.d, MAIN, { token, amount: 10, expectedPay: 10.11 })).toMatchObject({ status: 403 })
  })
})

// ───────────────────────── bundles harness ─────────────────────────

const ITEMS = [{ Value: "x_Data_1", Display: "Data 1GB", Amount: 10 }]

function bundlesHarness(over: Partial<BotBundlesDeps> & { cashback?: any; hubtel?: any } = {}) {
  const { caps, limits, counts } = fakeCaps()
  const inserts: BotBundleInsert[] = []
  const rows: (BotOrderRow & { bot_surface: string; buyer_phone: string; idempotency_key: string })[] = []
  const d: BotBundlesDeps = {
    getCashbackConfig: async () => over.cashback ?? CASHBACK(),
    getBuyerTier: async () => "customer",
    getBundlesConfig: async () => resolveBundlesConfig({ enabled: true, networks: { MTN: { enabled: true, hiddenCategories: [] } } }),
    getHubtelConfig: async () => over.hubtel ?? { enabled: true, paused: false, services: { data_mtn: true } },
    query: async () => ({ ok: true, data: ITEMS as any }),
    purchase: async () => { throw new Error("never in create") },
    getPrefixConfig: async () => ({ enabled: true, map: { MTN: ["24", "54", "55", "59", "25", "53"], TELECEL: ["20", "50"], AT: ["26", "27", "56", "57"] } }),
    findOrderByIdempotencyKey: async () => { throw new Error("dashboard lookup must not be used") },
    insertOrder: async () => { throw new Error("dashboard insert must not be used") },
    getOrder: async () => null,
    updateOrder: async () => 0,
    debitOrder: async () => { throw new Error("never debits") },
    alert: async () => {},
    newReference: () => `SB-REF${rows.length + 1}`,
    secret: "s3cret",
    now: () => NOW,
    async findBotBundleOrder(surface, phone, key) {
      return rows.find(r => r.bot_surface === surface && r.buyer_phone === phone && r.idempotency_key === key) ?? null
    },
    async insertBotBundleOrder(row) {
      if (rows.some(r => r.bot_surface === row.bot_surface && r.buyer_phone === row.buyer_phone && r.idempotency_key === row.idempotency_key)) {
        throw Object.assign(new Error("dup"), { code: "23505" })
      }
      inserts.push(row)
      const s = {
        id: `order-${rows.length + 1}`, reference_code: row.reference_code, amount: row.amount, paid_amount: row.paid_amount,
        payment_fee_amount: row.payment_fee_amount, cashback_amount: row.cashback_amount,
        bot_surface: row.bot_surface, buyer_phone: row.buyer_phone, idempotency_key: row.idempotency_key,
      }
      rows.push(s)
      return s
    },
    caps,
    ...over,
  }
  return { d, inserts, rows, limits, counts }
}

async function bundleToken(d: BotBundlesDeps, ctx: BotContext) {
  const c = await botCatalog(d, ctx, "MTN")
  if (!c.ok) throw new Error("catalog failed " + JSON.stringify(c))
  return c.categories.flatMap(x => x.bundles)[0].token
}

const KEY = "wa-0001-abcd"

beforeEach(() => __resetCatalogCache())

describe("botCatalog", () => {
  it("prices every plan with quoteBots for the bot's rail and split", async () => {
    const { d } = bundlesHarness()
    const main: any = await botCatalog(d, MAIN, "MTN")
    expect(main.categories[0].bundles[0]).toMatchObject({ amount: 10, payAmount: 10.11, customerCashback: 0.09, paymentFee: 0.2, token: expect.any(String) })
    const shop: any = await botCatalog(d, SHOPBOT, "MTN")
    expect(shop.categories[0].bundles[0]).toMatchObject({ payAmount: 10.03, customerCashback: 0.07, paymentFee: 0.1 })
    expect(JSON.stringify(shop)).not.toMatch(/shopShare/)
  })

  it.each([
    ["bots group off", { cashback: CASHBACK({ botGroups: { bundles: false } }) }, 403],
    ["hubtel paused", { hubtel: { enabled: true, paused: true, services: { data_mtn: true } } }, 503],
  ])("%s => %i", async (_n, over, status) => {
    const { d } = bundlesHarness(over as any)
    expect(await botCatalog(d, MAIN, "MTN")).toMatchObject({ ok: false, status })
  })
})

describe("botCreateBundleOrder", () => {
  it("main bot: bots row with recipient 233, buyer 233, no shop share", async () => {
    const { d, inserts } = bundlesHarness()
    const token = await bundleToken(d, MAIN)
    const r = await botCreateBundleOrder(d, MAIN, { token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 10.11 })
    expect(r).toEqual({ ok: true, order: { id: "order-1", reference: "SB-REF1", payAmount: 10.11, faceAmount: 10, customerCashback: 0.09, paymentFee: 0.2 } })
    expect(inserts[0]).toMatchObject({
      channel: "bots", bot_surface: "whatsapp", shop_id: null, user_id: null, buyer_phone: "233241234567",
      beneficiary_phone: "233541112222", amount: 10, paid_amount: 10.11, payment_fee_amount: 0.2,
      status: "pending", payment_status: "unpaid", idempotency_key: KEY, shop_share_amount: 0, cashback_amount: 0.09,
    })
  })

  it("shop bot: shop share snapshot", async () => {
    const { d, inserts } = bundlesHarness()
    const token = await bundleToken(d, SHOPBOT)
    const r = await botCreateBundleOrder(d, SHOPBOT, { token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 10.03 })
    expect(r.ok).toBe(true)
    expect(inserts[0]).toMatchObject({ shop_id: SHOP, bot_surface: "ussd_shop", shop_share_amount: 0.15 })
  })

  it("same key retried => the same order, one row (even after the token expired)", async () => {
    const { d, inserts } = bundlesHarness()
    const token = await bundleToken(d, MAIN)
    const a = await botCreateBundleOrder(d, MAIN, { token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 10.11 })
    const b = await botCreateBundleOrder(d, MAIN, { token: "stale", recipient: "0541112222", idempotencyKey: KEY, expectedPay: 1 })
    expect(b).toEqual(a)
    expect(inserts).toHaveLength(1)
  })

  it("concurrent insert loses on 23505 => the winner's order", async () => {
    const h = bundlesHarness()
    const token = await bundleToken(h.d, MAIN)
    let first = true
    const d: BotBundlesDeps = {
      ...h.d,
      // the pre-check misses (race), the insert collides
      findBotBundleOrder: async (...a) => (first ? ((first = false), null) : h.d.findBotBundleOrder(...a)),
    }
    h.rows.push({ id: "won", reference_code: "SB-WON", amount: 10, paid_amount: 10.11, payment_fee_amount: 0.2, cashback_amount: 0.09,
      bot_surface: "whatsapp", buyer_phone: "233241234567", idempotency_key: KEY })
    const r = await botCreateBundleOrder(d, MAIN, { token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 10.11 })
    expect(r).toMatchObject({ ok: true, order: { id: "won", reference: "SB-WON" } })
  })

  it("price drift => 409 with quote; wrong network number => 400; nothing written", async () => {
    const { d, inserts } = bundlesHarness()
    const token = await bundleToken(d, MAIN)
    expect(await botCreateBundleOrder(d, MAIN, { token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 10 }))
      .toMatchObject({ ok: false, status: 409, quote: { payAmount: 10.11 } })
    expect(await botCreateBundleOrder(d, MAIN, { token, recipient: "0201112222", idempotencyKey: "wa-0002-abcd", expectedPay: 10.11 }))
      .toMatchObject({ ok: false, status: 400 })
    expect(inserts).toHaveLength(0)
  })

  it("bad key / bad context => 400", async () => {
    const { d } = bundlesHarness()
    expect(await botCreateBundleOrder(d, MAIN, { token: "x", recipient: "0541112222", idempotencyKey: "short", expectedPay: 1 })).toMatchObject({ status: 400 })
    expect(await botCreateBundleOrder(d, { ...MAIN, shopId: SHOP }, { token: "x", recipient: "0541112222", idempotencyKey: KEY, expectedPay: 1 }))
      .toMatchObject({ status: 400 })
  })
})

// ───────────────────────── abuse caps ─────────────────────────

describe("bot abuse caps", () => {
  const TOO_MANY = { ok: false, status: 429, error: TOO_MANY_REQUESTS }

  it("verify: phone 20/10 min, surface+shop 300/h, global 2000/h — counted after validation, before the lookup", async () => {
    const h = billsHarness()
    await botVerifyBill(h.d, SHOPBOT, { biller: "dstv", account: "1234567890" })
    expect(h.limits).toEqual([
      { name: "bot_bill_verify_phone", max: 20, windowMs: 600_000, id: "p:233241234567" },
      { name: "bot_bill_verify_surface", max: 300, windowMs: 3_600_000, id: `s:ussd_shop:${SHOP}` },
      { name: "bot_bill_verify_all", max: 2000, windowMs: 3_600_000, id: "all" },
    ])
    const bad = billsHarness()
    expect(await botVerifyBill(bad.d, MAIN, { biller: "dstv", account: "!" })).toMatchObject({ status: 400 })
    expect(bad.limits).toEqual([]) // invalid input never consumes a slot
  })

  it.each(["bot_bill_verify_phone", "bot_bill_verify_surface", "bot_bill_verify_all"])("verify over %s => 429, no Hubtel query", async name => {
    let looked = false
    const { caps } = fakeCaps({ block: name })
    const h = billsHarness({ caps, query: async () => { looked = true; return { ok: true, data: [] } } })
    expect(await botVerifyBill(h.d, MAIN, { biller: "dstv", account: "1234567890" })).toEqual(TOO_MANY)
    expect(looked).toBe(false)
  })

  it("bill create: phone 5/h (main bot has no shop cap)", async () => {
    const h = billsHarness()
    const token = await billToken(h.d, MAIN)
    h.limits.length = 0
    await botCreateBillOrder(h.d, MAIN, { token, amount: 10, expectedPay: 10.11 })
    expect(h.limits).toEqual([{ name: "bot_bill_cap_phone", max: 5, windowMs: 3_600_000, id: "p:233241234567" }])
    expect(h.counts).toEqual([{ table: "hubtel_bill_orders", column: "buyer_phone", value: "233241234567" }])
  })

  it.each([
    ["phone limiter", { block: "bot_bill_cap_phone" }],
    ["shop limiter", { block: "bot_bill_cap_shop_1h" }],
    ["phone DB count", { pending: { buyer_phone: 5 } }],
    ["shop DB count", { pending: { shop_id: 60 } }],
  ])("bill create over %s => 429, nothing written", async (_n, opts) => {
    const h = billsHarness()
    const token = await billToken(h.d, SHOPBOT)
    const d = { ...h.d, caps: fakeCaps(opts as any).caps }
    expect(await botCreateBillOrder(d, SHOPBOT, { token, amount: 10, expectedPay: 10.03 })).toEqual(TOO_MANY)
    expect(h.inserts).toHaveLength(0)
  })

  it("under the DB caps (4 pending / 59 shop) => created", async () => {
    const h = billsHarness()
    const token = await billToken(h.d, SHOPBOT)
    const d = { ...h.d, caps: fakeCaps({ pending: { buyer_phone: 4, shop_id: 59 } }).caps }
    expect((await botCreateBillOrder(d, SHOPBOT, { token, amount: 10, expectedPay: 10.03 })).ok).toBe(true)
  })

  it("a price-change 409 and a same-token retry never consume a slot", async () => {
    const h = billsHarness()
    const token = await billToken(h.d, MAIN)
    h.limits.length = 0
    expect(await botCreateBillOrder(h.d, MAIN, { token, amount: 10, expectedPay: 9 })).toMatchObject({ status: 409 })
    expect(h.limits).toEqual([])
    await botCreateBillOrder(h.d, MAIN, { token, amount: 10, expectedPay: 10.11 })
    expect(h.limits).toHaveLength(1)
    await botCreateBillOrder(h.d, MAIN, { token, amount: 10, expectedPay: 10.11 })
    expect(h.limits).toHaveLength(1)
  })

  it("bundle create: phone 5/h + shop 60/h; 409 consumes nothing; over => 429", async () => {
    const h = bundlesHarness()
    const token = await bundleToken(h.d, SHOPBOT)
    expect(await botCreateBundleOrder(h.d, SHOPBOT, { token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 1 })).toMatchObject({ status: 409 })
    expect(h.limits).toEqual([])
    await botCreateBundleOrder(h.d, SHOPBOT, { token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 10.03 })
    expect(h.limits).toEqual([
      { name: "bot_bundle_cap_phone", max: 5, windowMs: 3_600_000, id: "p:233241234567" },
      { name: "bot_bundle_cap_shop_1h", max: 60, windowMs: 3_600_000, id: `s:${SHOP}` },
    ])
    for (const opts of [{ block: "bot_bundle_cap_phone" }, { block: "bot_bundle_cap_shop_1h" }, { pending: { buyer_phone: 5 } }, { pending: { shop_id: 60 } }]) {
      const b = bundlesHarness()
      const t = await bundleToken(b.d, SHOPBOT)
      const d = { ...b.d, caps: fakeCaps(opts as any).caps }
      expect(await botCreateBundleOrder(d, SHOPBOT, { token: t, recipient: "0541112222", idempotencyKey: KEY, expectedPay: 10.03 })).toEqual(TOO_MANY)
      expect(b.inserts).toHaveLength(0)
    }
  })

  it("storefront pending caps are unchanged", async () => {
    const { checkPendingCaps } = await import("@/lib/storefront-commission/shop")
    const seen: any[] = []
    await checkPendingCaps({
      limit: async (name, max, windowMs, id) => (seen.push({ name, max, windowMs, id }), true),
      countPending: async () => 0, now: () => NOW,
    }, "bill", "hubtel_bill_orders", { email: "a@b.co", phone: "0241234567", shopId: "shop-A" })
    expect(seen).toEqual([
      { name: "shop_bill_cap_email", max: 5, windowMs: 3_600_000, id: "e:a@b.co" },
      { name: "shop_bill_cap_phone", max: 5, windowMs: 3_600_000, id: "p:0241234567" },
      { name: "shop_bill_cap_shop_5m", max: 15, windowMs: 300_000, id: "s:shop-A" },
      { name: "shop_bill_cap_shop_1h", max: 60, windowMs: 3_600_000, id: "s:shop-A" },
    ])
  })
})
