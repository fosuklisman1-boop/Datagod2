import { formatForWhatsApp } from "@/lib/whatsapp-bot/send"

describe("formatForWhatsApp", () => {
  it("converts **bold** and __bold__ to WhatsApp single-asterisk bold", () => {
    expect(formatForWhatsApp("**hi** and __there__")).toBe("*hi* and *there*")
  })

  it("converts markdown headings to bold lines", () => {
    expect(formatForWhatsApp("## Title")).toBe("*Title*")
    expect(formatForWhatsApp("   ### Indented")).toBe("*Indented*")
  })

  it("rewrites markdown links to 'label (url)'", () => {
    expect(formatForWhatsApp("see [our site](https://x.co)")).toBe("see our site (https://x.co)")
  })

  it("leaves plain text and existing single-asterisk bold untouched", () => {
    expect(formatForWhatsApp("just text")).toBe("just text")
    expect(formatForWhatsApp("*already bold*")).toBe("*already bold*")
  })

  it("returns falsy input unchanged", () => {
    expect(formatForWhatsApp("")).toBe("")
  })
})
