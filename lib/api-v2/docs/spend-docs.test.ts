import { describe, expect, it } from "vitest"
import { buildErrorGuide } from "./error-guide"
import { changelogAt } from "./changelog"
import { SPEND_CAPS_PUBLISHED } from "./flags"
import { MSG_DAILY_LIMIT } from "../access"

const mentions = (s: string) => /DAILY_LIMIT|daily (spending )?limit/i.test(s)
const NOW = new Date("2026-11-25T12:00:00Z")

describe("daily limit docs flag", () => {
  it("ships switched off", () => {
    expect(SPEND_CAPS_PUBLISHED).toBe(false)
  })
  it("flag off: neither the error guide nor the changelog mentions daily limits", () => {
    expect(mentions(JSON.stringify(buildErrorGuide()))).toBe(false)
    expect(mentions(JSON.stringify(changelogAt(NOW)))).toBe(false)
  })
  it("flag on: exactly one API-wide 402 DAILY_LIMIT_REACHED entry in Money, fix says 00:00 GMT or raise the limit", () => {
    const e = buildErrorGuide(undefined, { spendCaps: true }).filter((x) => x.code === "DAILY_LIMIT_REACHED")
    expect(e).toHaveLength(1)
    expect(e[0].status).toBe(402)
    expect(e[0].group).toBe("Money")
    expect(e[0].messages).toContain(MSG_DAILY_LIMIT)
    expect(e[0].fix).toMatch(/00:00 GMT/)
    expect(e[0].fix).toMatch(/raise the limit/i)
    expect(e[0].fix).toMatch(/dashboard/i)
    expect(e[0].appliesTo).toBe("Live purchase endpoints when a daily limit is set")
  })
  it("flag on: one changelog entry, released, in date order", () => {
    const all = changelogAt(NOW, { spendCaps: true })
    const e = all.filter((x) => mentions(x.title + x.items.join(" ")))
    expect(e).toHaveLength(1)
    expect(e[0].status).toBe("released")
    for (let i = 1; i < all.length; i++) expect(all[i - 1].date >= all[i].date).toBe(true)
  })
})
