import { describe, it, expect } from "vitest"
import { DATA_PAGE_COPY, dataPageParagraphs, wordCount } from "./data-page-copy"
import { DATA_NETS, type DataNet } from "./data-prices"

const BANNED = /instant|in seconds|automatic(ally)? refund/i

const allParagraphs = (net: DataNet) => [...DATA_PAGE_COPY[net].paragraphs, ...DATA_PAGE_COPY[net].when.map((w) => w.text)]
const text = (net: DataNet) => [DATA_PAGE_COPY[net].tableHeading, DATA_PAGE_COPY[net].aboutHeading, ...allParagraphs(net)].join("\n")

describe("data page copy", () => {
  it("is 150-300 words per network, even with every conditional paragraph shown", () => {
    for (const net of DATA_NETS) {
      const base = wordCount(DATA_PAGE_COPY[net].paragraphs.join(" "))
      const full = wordCount(allParagraphs(net).join(" "))
      expect(base, `${net} base (${base})`).toBeGreaterThanOrEqual(150)
      expect(full, `${net} full (${full})`).toBeLessThanOrEqual(300)
    }
  })

  it("never uses banned speed / refund wording", () => {
    for (const net of DATA_NETS) expect(text(net), net).not.toMatch(BANNED)
  })

  it("never states a price, amount, rating or USSD code (prices come only from the table)", () => {
    for (const net of DATA_NETS) {
      const t = text(net)
      expect(t, net).not.toMatch(/GH₵|GHS|cedis? ?\d|\d+(\.\d+)? ?(GB|MB)/i)
      expect(t, net).not.toMatch(/\*\d{2,4}[*#]/)
      expect(t, net).not.toMatch(/rating|review|stars?\b|\d+%/i)
      // The only numbers allowed are phone prefixes (0 + 2 digits).
      for (const n of t.match(/\d+/g) ?? []) expect(n, `${net}: ${n}`).toMatch(/^0\d\d$/)
    }
  })

  it("mentions MoMo on every page", () => {
    for (const net of DATA_NETS) expect(text(net), net).toMatch(/MoMo/)
  })

  it("covers each network's own topics", () => {
    expect(text("MTN")).toMatch(/024, 025, 053, 054, 055 or 059/)
    expect(text("MTN")).toMatch(/MTN Mobile Money/)
    expect(text("Telecel")).toMatch(/Vodafone/)
    expect(text("Telecel")).toMatch(/No expiry/)
    expect(text("Telecel")).toMatch(/020 or 050/)
    expect(text("AT")).toMatch(/AirtelTigo/)
    expect(text("AT")).toMatch(/iShare/)
    expect(text("AT")).toMatch(/BigTime/)
  })

  it("shares no paragraph between networks", () => {
    const seen = new Map<string, DataNet>()
    for (const net of DATA_NETS) {
      for (const p of allParagraphs(net)) {
        expect(seen.get(p), `${net} repeats: ${p}`).toBeUndefined()
        seen.set(p, net)
      }
    }
  })

  it("keeps switchable sub-products out of the always-on AT paragraphs", () => {
    expect(DATA_PAGE_COPY.AT.paragraphs.join("\n")).not.toMatch(/ishare|bigtime/i)
    expect(DATA_PAGE_COPY.Telecel.paragraphs.join("\n")).not.toMatch(/no expiry/i)
  })

  it("shows a conditional paragraph only when the table has matching rows", () => {
    const none = dataPageParagraphs("AT", [])
    expect(none.join("\n")).not.toMatch(/iShare|BigTime/)
    expect(none).toEqual(DATA_PAGE_COPY.AT.paragraphs)

    const ishareOnly = dataPageParagraphs("AT", [{ type: "iShare", validity: null }])
    expect(ishareOnly.join("\n")).toMatch(/iShare/)
    expect(ishareOnly.join("\n")).not.toMatch(/BigTime/)

    expect(dataPageParagraphs("Telecel", [{ type: null, validity: "30 days" }]).join("\n")).not.toMatch(/No expiry/)
    expect(dataPageParagraphs("Telecel", [{ type: null, validity: "No expiry" }]).join("\n")).toMatch(/No expiry/)
  })
})
