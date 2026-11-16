import { describe, expect, it } from "vitest"
import { calculateSegments } from "@/lib/sms/segments"
import { callShopReply, callSupportReply } from "./replies"

const oneSegment = (s: string) => {
  const r = calculateSegments(s)
  return r.encoding === "gsm7" && r.segments === 1
}

describe("callSupportReply", () => {
  it("points at the WhatsApp link in one GSM-7 segment", () => {
    const t = callSupportReply("233559919037")
    expect(t).toBe("Sorry we missed your call. For help WhatsApp us: https://wa.me/233559919037")
    expect(oneSegment(t)).toBe(true)
  })
})

describe("callShopReply", () => {
  it("names the shop and the owner number", () => {
    const t = callShopReply("Kofi Data", "0244000111")
    expect(t).toBe("Sorry we missed your call. Please contact Kofi Data on 0244000111.")
    expect(oneSegment(t)).toBe(true)
  })

  it("stays one GSM-7 segment for a 60 character accented, emoji shop name", () => {
    const name = "Café Élève 🚀 Data Hub über ça va très bien ok 123"
    const long = (name + "é".repeat(60)).slice(0, 60)
    const t = callShopReply(long, "0244000111")
    expect(oneSegment(t)).toBe(true)
    expect(t).toContain("0244000111")
    expect(t.startsWith("Sorry we missed your call. Please contact ")).toBe(true)
  })

  it("falls back to Shop when nothing printable is left", () => {
    expect(callShopReply("🚀🚀", "0244000111")).toContain("contact Shop on 0244000111")
  })
})
