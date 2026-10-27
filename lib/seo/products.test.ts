import { describe, it, expect } from "vitest"
import { PRODUCTS, getProduct, type ProductKey } from "./products"
import { BILLER_KEYS, BILLERS } from "@/lib/bills/billers"

const REFUND = "If an order fails, you get your money back."
const SPEED = "Usually delivered within minutes."
const BANNED = /instant|in seconds|automatic(ally)? refund/i

function allText(p: (typeof PRODUCTS)[number]): string {
  return [p.name, p.h1, p.title, p.description, p.summary, ...p.bullets, ...p.faqs.flatMap((f) => [f.question, f.answer])].join("\n")
}

describe("product registry", () => {
  it("has unique keys and paths", () => {
    const keys = PRODUCTS.map((p) => p.key)
    const paths = PRODUCTS.map((p) => p.path)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it("covers all 18 product keys with path = /key", () => {
    expect(PRODUCTS).toHaveLength(18)
    for (const p of PRODUCTS) expect(p.path).toBe(`/${p.key}`)
  })

  it("only relates to keys that exist, never itself", () => {
    const keys = new Set<ProductKey>(PRODUCTS.map((p) => p.key))
    for (const p of PRODUCTS) {
      for (const r of p.related) expect(keys.has(r), `${p.key} -> ${r}`).toBe(true)
      expect(p.related).not.toContain(p.key)
    }
  })

  it("has exactly one entry per biller key", () => {
    for (const b of BILLER_KEYS) {
      expect(PRODUCTS.filter((p) => p.biller === b), b).toHaveLength(1)
    }
  })

  it("keeps titles <= 60 chars ending in | DATAGOD and descriptions 120-160 chars", () => {
    for (const p of PRODUCTS) {
      expect(p.title.length, `${p.key} title: ${p.title}`).toBeLessThanOrEqual(60)
      expect(p.title.endsWith("| DATAGOD"), p.key).toBe(true)
      expect(p.description.length, `${p.key} description (${p.description.length})`).toBeGreaterThanOrEqual(120)
      expect(p.description.length, `${p.key} description (${p.description.length})`).toBeLessThanOrEqual(160)
    }
  })

  it("has 4-8 FAQs including the verbatim refund and speed lines", () => {
    for (const p of PRODUCTS) {
      expect(p.faqs.length, p.key).toBeGreaterThanOrEqual(4)
      expect(p.faqs.length, p.key).toBeLessThanOrEqual(8)
      expect(p.faqs.some((f) => f.answer.includes(REFUND)), `${p.key} refund FAQ`).toBe(true)
      expect(p.faqs.some((f) => f.answer.includes(SPEED)), `${p.key} speed FAQ`).toBe(true)
    }
  })

  it("never uses banned speed/refund wording", () => {
    for (const p of PRODUCTS) expect(allText(p), p.key).not.toMatch(BANNED)
  })

  it("keeps at-data copy neutral about switchable AT sub-products", () => {
    expect(allText(getProduct("at-data"))).not.toMatch(/ishare|bigtime/i)
  })

  it("never implies direct checkout on the website (wallet is funded, then spent)", () => {
    for (const p of PRODUCTS) {
      for (const b of p.bullets) expect(b, `${p.key}: ${b}`).not.toMatch(/^Pay with MoMo or card through Paystack/)
    }
  })

  it("mentions MoMo or Paystack payment on every entry", () => {
    for (const p of PRODUCTS) expect(allText(p), p.key).toMatch(/MoMo|Mobile Money|Paystack/)
  })

  it("never hardcodes a USSD short code", () => {
    for (const p of PRODUCTS) expect(allText(p), p.key).not.toMatch(/\*\d{2,4}[*#]/)
  })

  it("never names individually switchable parts in hub / shared copy", () => {
    // Pages render the live list from facts.parts; static copy must stay true when one part is off.
    const NETWORKS = /MTN|Telecel|AT |AT\)|AirtelTigo/
    const BOARDS = /WASSCE|BECE|NovDec/i
    const billerNames = [...Object.values(BILLERS).map((b) => b.label), "ECG", "Ghana Water", "DSTV", "GOtv", "StarTimes", "Telecel Broadband"]
    const generic: ProductKey[] = ["airtime", "utility-bills", "results-checker", "bulk-sms", "join", "ussd", "whatsapp", "developers"]
    for (const key of generic) {
      const text = allText(getProduct(key))
      expect(text, `${key} names a network`).not.toMatch(NETWORKS)
      expect(text, `${key} names an exam board`).not.toMatch(BOARDS)
      for (const b of billerNames) expect(text.includes(b), `${key} names biller ${b}`).toBe(false)
    }
  })

  it("never claims every shop already has a USSD code", () => {
    for (const p of PRODUCTS) expect(allText(p), p.key).not.toMatch(/(has|gets) its own (USSD )?(shop )?code/i)
  })

  it("lists USSD as an AFA channel", () => {
    expect(getProduct("afa-registration").channels).toContain("ussd")
  })

  it("uses the agreed sitemap priorities", () => {
    const expected: Record<ProductKey, number> = {
      "mtn-data": 0.9, "telecel-data": 0.9, "at-data": 0.9,
      airtime: 0.8, "afa-registration": 0.8, "utility-bills": 0.8, "results-checker": 0.8, "bulk-sms": 0.8, join: 0.8,
      "ecg-prepaid": 0.7, "ghana-water": 0.7, "pay-dstv": 0.7, "pay-gotv": 0.7, startimes: 0.7, "telecel-broadband": 0.7,
      ussd: 0.6, whatsapp: 0.6, developers: 0.6,
    }
    for (const p of PRODUCTS) expect(p.priority, p.key).toBe(expected[p.key])
  })

  it("marks the hand-built pages as not having their own registry page", () => {
    const handBuilt = new Set(["join", "results-checker", "bulk-sms", "whatsapp", "developers"])
    for (const p of PRODUCTS) expect(p.hasOwnPage, p.key).toBe(!handBuilt.has(p.key))
  })

  it("sets network on data pages", () => {
    expect(getProduct("mtn-data").network).toBe("MTN")
    expect(getProduct("telecel-data").network).toBe("Telecel")
    expect(getProduct("at-data").network).toBe("AT")
  })

  it("getProduct returns the entry and throws on an unknown key", () => {
    expect(getProduct("airtime").path).toBe("/airtime")
    expect(() => getProduct("nope" as ProductKey)).toThrow()
  })
})
