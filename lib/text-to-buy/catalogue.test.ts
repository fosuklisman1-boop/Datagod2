import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFakeCatalogue } from "./fake-catalogue.test-helper"
import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "@/lib/phone-format"

const h = vi.hoisted(() => ({
  client: null as any,
  map: null as any,
  blocked: vi.fn(async (_network: string | null | undefined, _phone: string) => false),
  subAgent: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => h.client.from(t) }) }))
vi.mock("next/server", () => ({ after: vi.fn() }))
// bundles.ts imports the Redis session store and the Paystack client; neither is used by the catalogue.
vi.mock("@/lib/ussd/session", () => ({ setSession: vi.fn() }))
vi.mock("@/lib/paystack", () => ({ submitOtp: vi.fn() }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: true, map: h.map })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: h.blocked, RECIPIENT_BLOCKED_PROMPT: "" }))
vi.mock("@/lib/shop-commerce/pricing", async (orig) => ({ ...(await orig<object>()), subAgentBundles: h.subAgent }))

import { parseSizeMb, sizeLabel, resolveOffer, listPrices, sessionForOffer, type Offer } from "./catalogue"
import { fetchBundles } from "@/lib/ussd/handlers/bundles"

// Senders are 0200000101..199 (prefix 20). The admin prefix map decides their carrier, so each test chooses which
// carrier prefix 20 belongs to. Recipients use real default prefixes of the other carriers.
const SENDER = "0200000101"
const MTN_R = "0240000103"
const TELECEL_R = "0500000104"
const AT_R = "0270000105"

function senderOn(carrier: "MTN" | "TELECEL" | "AT") {
  const m: NetworkPrefixMap = {
    MTN: [...DEFAULT_NETWORK_PREFIXES.MTN], TELECEL: DEFAULT_NETWORK_PREFIXES.TELECEL.filter((p) => p !== "20"), AT: [...DEFAULT_NETWORK_PREFIXES.AT],
  }
  m[carrier].push("20")
  h.map = m
}

const pkg = (id: string, network: string, size: string, price: number, dealer: number | null = null, avail = true) =>
  ({ id, network, size, price, dealer_price: dealer, is_available: avail })

function seed(over: Record<string, any[]> = {}) {
  const f = makeFakeCatalogue({
    packages: [
      pkg("m1", "MTN", "1", 10, 8), pkg("m2", "MTN", "2GB", 20, 16), pkg("m5", "MTN", "5GB", 50, 40), pkg("m10", "MTN", "10", 100, 80),
      pkg("mu", "MTN", "Unlimited", 5), pkg("mx", "MTN", "5GB", 99, null, false),
      pkg("t5", "Telecel", "5GB", 48, 38),
      pkg("i2", "AT-iShare", "2GB", 18, 14), pkg("i5", "AT-iShare", "5GB", 45, 36),
      pkg("b5", "AT-BigTime", "5GB", 40, 33), pkg("b10", "AT-BigTime", "10GB", 80, 66),
    ],
    users: [],
    app_settings: [{ key: null, ussd_price_tier: "regular" }],
    admin_settings: [],
    wallets: [],
    user_shops: [],
    user_package_prices: [],
    ...over,
  })
  h.client = f.client
  return f
}

beforeEach(() => {
  h.blocked.mockReset().mockResolvedValue(false)
  h.subAgent.mockReset()
  senderOn("MTN")
  seed()
})

describe("parseSizeMb", () => {
  // Spellings seen in repo fixtures, seeds and migrations; the production catalogue query is a launch-gate item.
  it.each([
    ["1", 1000], ["2", 2000], ["5", 5000], ["10", 10000], ["1.5", 1500],
    ["1GB", 1000], ["5GB", 5000], ["5gb", 5000], ["5 GB", 5000], ["1.5GB", 1500], ["10GB", 10000], ["100GB", 100000],
    ["500MB", 500], ["500 MB", 500], ["500mb", 500],
  ])("%s -> %s", (s, mb) => expect(parseSizeMb(s)).toBe(mb))

  it.each(["", "  ", "unlimited", "Unlimited", "x", "3GB MTN", "1GB MTN", "0", "0GB", "-5GB", "5TB", "five"])("%j -> null", (s) =>
    expect(parseSizeMb(s)).toBeNull()
  )

  it("sizeLabel normalises the spelling for text", () => {
    expect(["5", "5 GB", "5gb", "500 MB", "1.5"].map(sizeLabel)).toEqual(["5GB", "5GB", "5GB", "500MB", "1.5GB"])
  })
})

describe("resolveOffer: network and match", () => {
  it("MTN sender, no hint, no recipient: sells to self", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r.ok && r.offer).toMatchObject({
      network: "MTN", networkLabel: "MTN", bundleId: "m5", size: "5GB", price: 50, recipientLocal: SENDER, gift: false,
    })
    // the sender's OWN number decides the MoMo provider (prefix 20 = vod), not the data network
    expect(r.ok && r.offer.paystackProvider).toBe("vod")
  })

  it("an unavailable package is never sold (the cheaper 5GB at 99 is hidden; 50 is sold)", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r.ok && r.offer.price).toBe(50)
  })

  it("MTN sender gifting an AT number: AT products are considered, gift true", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 2000, networkHint: null, recipient: AT_R })
    expect(r.ok && r.offer).toMatchObject({ network: "AT-iShare", networkLabel: "AT", price: 18, gift: true, recipientLocal: AT_R })
  })

  it("the recipient's carrier, not the sender's, picks the network", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: TELECEL_R })
    expect(r.ok && r.offer).toMatchObject({ network: "Telecel", price: 48, gift: true })
  })

  it("AT: size only in iShare -> that product", async () => {
    senderOn("AT")
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 2000, networkHint: null, recipient: null })
    expect(r.ok && r.offer.network).toBe("AT-iShare")
  })

  it("AT: size in both products -> choose_product with both options", async () => {
    senderOn("AT")
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === "choose_product") {
      expect(r.options.map((o) => [o.network, o.price])).toEqual([["AT-iShare", 45], ["AT-BigTime", 40]])
    } else throw new Error("expected choose_product")
  })

  it("AT: hint BigTime -> that product only; hint iShare -> iShare; hint AT -> still ambiguous", async () => {
    senderOn("AT")
    const ask = (networkHint: any) => resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint, recipient: null })
    const big = await ask("AT-BigTime")
    expect(big.ok && big.offer).toMatchObject({ network: "AT-BigTime", price: 40 })
    const ish = await ask("AT-iShare")
    expect(ish.ok && ish.offer.network).toBe("AT-iShare")
    expect((await ask("AT")).ok).toBe(false)
  })

  it("AT: hint BigTime for a size only iShare has -> no_package (never silently the other product)", async () => {
    senderOn("AT")
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 2000, networkHint: "AT-BigTime", recipient: null })
    expect(r).toMatchObject({ ok: false, reason: "no_package", networkLabel: "AT" })
  })

  it("two packages of one size on one product: the cheaper", async () => {
    seed({ packages: [pkg("a", "MTN", "5GB", 60), pkg("b", "MTN", "5", 55), pkg("c", "MTN", "5 GB", 58)] })
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r.ok && r.offer.bundleId).toBe("b")
  })

  it("a package with an unparseable size is never matched or suggested", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 3000, networkHint: null, recipient: null })
    expect(r.ok === false && r.reason === "no_package" && r.nearest.map((n) => n.size)).toEqual(["2GB", "1GB", "5GB"]) // 5GB and 1GB are equally far: the cheaper first
  })
})

describe("resolveOffer: hints and recipients", () => {
  it("hint naming another carrier, no recipient -> need_recipient", async () => {
    senderOn("AT")
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: "MTN", recipient: null })
    expect(r).toEqual({ ok: false, reason: "need_recipient", networkLabel: "MTN" })
  })

  it("hint naming another carrier than the explicit recipient's -> bad_recipient", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: "MTN", recipient: TELECEL_R })
    expect(r).toEqual({ ok: false, reason: "bad_recipient" })
  })

  it("hint matching the recipient's carrier is fine", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: "Telecel", recipient: TELECEL_R })
    expect(r.ok).toBe(true)
  })

  it("an unrecognised or malformed recipient -> bad_recipient", async () => {
    for (const recipient of ["0100000000", "12345", "0240000"]) {
      const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient })
      expect(r).toEqual({ ok: false, reason: "bad_recipient" })
    }
  })

  it("a recipient written +233... is normalised to local", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: "+233500000104" })
    expect(r.ok && r.offer.recipientLocal).toBe(TELECEL_R)
  })

  it("a blocked MTN recipient -> bad_recipient, checked with the MTN network and the recipient", async () => {
    h.blocked.mockResolvedValue(true)
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: MTN_R })
    expect(r).toEqual({ ok: false, reason: "bad_recipient" })
    expect(h.blocked).toHaveBeenCalledWith("MTN", MTN_R)
  })

  it("the block check is not run for a non-MTN recipient", async () => {
    h.blocked.mockResolvedValue(true)
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: TELECEL_R })
    expect(r.ok).toBe(true)
    expect(h.blocked).not.toHaveBeenCalled()
  })
})

describe("resolveOffer: no_package and service switch", () => {
  it("no package of that size: 3 nearest by distance", async () => {
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 4000, networkHint: null, recipient: null })
    expect(r).toEqual({
      ok: false, reason: "no_package", networkLabel: "MTN",
      nearest: [{ size: "5GB", priceGhs: 50 }, { size: "2GB", priceGhs: 20 }, { size: "1GB", priceGhs: 10 }],
    })
  })

  it("data hidden on the USSD menu -> service_off, before anything is priced", async () => {
    const f = seed({ admin_settings: [{ key: "ussd_service_visibility", value: { data: false } }] })
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r).toEqual({ ok: false, reason: "service_off" })
    expect(f.db.calls.some((c) => c.table === "packages")).toBe(false)
  })

  it("an unreadable visibility setting does not sell", async () => {
    const f = seed({ admin_settings: [] })
    f.db.failOn["admin_settings"] = { message: "boom" }
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r).toEqual({ ok: false, reason: "prices_unavailable" })
  })
})

describe("resolveOffer: price is the buyer's USSD price", () => {
  it("a dealer SENDER gets dealer_price", async () => {
    seed({ users: [{ id: "d1", role: "dealer", phone_number: SENDER }], wallets: [{ user_id: "d1", balance: 5 }] })
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r.ok && r.offer).toMatchObject({ price: 40, tier: { effectivePriceTier: "dealer", userId: "d1" } })
  })

  it("the tier is the sender's, not the recipient's: a dealer recipient does not make a regular sender pay dealer prices", async () => {
    seed({ users: [{ id: "d2", role: "dealer", phone_number: MTN_R }] })
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: MTN_R })
    expect(r.ok && r.offer).toMatchObject({ price: 50, gift: true, tier: { effectivePriceTier: "regular" } })
  })

  it("a dealer sender gifting still pays the dealer price", async () => {
    seed({ users: [{ id: "d1", role: "dealer", phone_number: SENDER }] })
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: MTN_R })
    expect(r.ok && r.offer.price).toBe(40)
  })

  it("a sub-agent sender gets the parent's live cost, asked of the parent's shop on the product's network", async () => {
    seed({
      users: [{ id: "s1", role: "sub_agent", phone_number: SENDER }],
      user_shops: [{ user_id: "s1", parent_shop_id: "shop-9" }],
    })
    h.subAgent.mockResolvedValue([{ id: "p-sub", size: "5GB", price: 43.5 }])
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(h.subAgent).toHaveBeenCalledWith("shop-9", "MTN", expect.anything())
    expect(r.ok && r.offer).toMatchObject({ bundleId: "p-sub", price: 43.5, tier: { effectivePriceTier: "sub_agent", subAgentParentShopId: "shop-9" } })
  })

  it("a sub-agent whose parent catalogue cannot be read -> prices_unavailable, never a role price", async () => {
    seed({
      users: [{ id: "s1", role: "sub_agent", phone_number: SENDER }],
      user_shops: [{ user_id: "s1", parent_shop_id: "shop-9" }],
    })
    h.subAgent.mockRejectedValue(new Error("x"))
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r).toEqual({ ok: false, reason: "prices_unavailable" })
  })

  it("custom prices apply; when they cannot be read -> prices_unavailable", async () => {
    const f = seed({
      users: [{ id: "c1", role: "user", phone_number: SENDER, pricing_mode: "custom" }],
      user_package_prices: [{ user_id: "c1", package_id: "m5", price: 31 }],
    })
    const ok = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(ok.ok && ok.offer.price).toBe(31)
    f.db.failOn["user_package_prices"] = { message: "boom" }
    const bad = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(bad).toEqual({ ok: false, reason: "prices_unavailable" })
  })

  it("the offered price equals what the USSD bundle menu shows the same buyer for that package", async () => {
    seed({ users: [{ id: "d1", role: "dealer", phone_number: SENDER }] })
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    const menu = await fetchBundles("MTN", 0, "dealer", undefined, "d1")
    expect(r.ok && r.offer.price).toBe(menu.bundles.find((b) => b.id === "m5")!.price)
  })

  it("a package priced at 0 or below is never sold", async () => {
    seed({ packages: [pkg("z", "MTN", "5GB", 0), pkg("n", "MTN", "5GB", -3)] })
    const r = await resolveOffer(h.client, { senderLocal: SENDER, sizeMb: 5000, networkHint: null, recipient: null })
    expect(r).toMatchObject({ ok: false, reason: "no_package" })
  })
})

describe("listPrices", () => {
  it("Telecel sender: own network's available packages, ascending by size, role price", async () => {
    senderOn("TELECEL")
    seed({ packages: [pkg("t5", "Telecel", "5GB", 48), pkg("t1", "Telecel", "1", 12), pkg("t500", "Telecel", "500MB", 6), pkg("tu", "Telecel", "Unlimited", 1)] })
    expect(await listPrices(h.client, SENDER)).toEqual({
      networkLabel: "Telecel",
      items: [{ size: "500MB", priceGhs: 6 }, { size: "1GB", priceGhs: 12 }, { size: "5GB", priceGhs: 48 }],
    })
  })

  it("AT sender: iShare and BigTime merged, tagged by product, ascending by size", async () => {
    senderOn("AT")
    expect(await listPrices(h.client, SENDER)).toEqual({
      networkLabel: "AT",
      items: [
        { size: "2GB iShare", priceGhs: 18 }, { size: "5GB BigTime", priceGhs: 40 }, { size: "5GB iShare", priceGhs: 45 },
        { size: "10GB BigTime", priceGhs: 80 },
      ],
    })
  })

  it("a dealer sees dealer prices", async () => {
    senderOn("TELECEL")
    seed({ users: [{ id: "d1", role: "dealer", phone_number: SENDER }] })
    const r = await listPrices(h.client, SENDER)
    expect(r?.items).toEqual([{ size: "5GB", priceGhs: 38 }])
  })

  it("null when nothing is available, when the carrier is unknown, or when a price cannot be read", async () => {
    senderOn("TELECEL")
    seed({ packages: [] })
    expect(await listPrices(h.client, SENDER)).toBeNull()
    expect(await listPrices(h.client, "0100000000")).toBeNull()
    const f = seed({ users: [{ id: "c1", role: "user", phone_number: SENDER, pricing_mode: "custom" }] })
    f.db.failOn["user_package_prices"] = { message: "boom" }
    expect(await listPrices(h.client, SENDER)).toBeNull()
  })
})

describe("sessionForOffer", () => {
  const offer: Offer = {
    network: "MTN", networkLabel: "MTN", bundleId: "m5", size: "5GB", price: 50, recipientLocal: MTN_R, gift: true,
    paystackProvider: "vod",
    tier: { effectivePriceTier: "dealer", subAgentParentShopId: undefined, userId: "d1", walletBalance: 123, mtnWhitelistActive: true },
  }

  it("is a CONFIRM session with the offer's fields and the sender in +233 form", () => {
    expect(sessionForOffer(SENDER, offer)).toEqual({
      step: "CONFIRM", dialingPhone: "+233200000101", network: "MTN", paystackProvider: "vod", bundleId: "m5", bundleSize: "5GB",
      bundlePrice: 50, recipientPhone: MTN_R, effectivePriceTier: "dealer", subAgentParentShopId: undefined, userId: "d1",
      mtnWhitelistActive: true,
    })
  })

  it("never carries a wallet balance, even when the tier had one", () => {
    const s = sessionForOffer(SENDER, offer)
    expect("walletBalance" in s).toBe(false)
    expect(s.step).toBe("CONFIRM")
  })
})
