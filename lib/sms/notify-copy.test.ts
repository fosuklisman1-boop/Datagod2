import { describe, it, expect, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { shortfallMessage, HUBTEL_OUT_OF_FUNDS_MESSAGE } from "./notify"

describe("admin notification copy names the Hubtel SMS wallet (not Disbursement)", () => {
  it("shortfall", () => {
    const m = shortfallMessage(120)
    expect(m).toMatch(/^120 units are pending/)
    expect(m).toMatch(/Hubtel SMS wallet/)
    expect(m).not.toMatch(/Disbursement/)
  })
  it("out of funds", () => {
    expect(HUBTEL_OUT_OF_FUNDS_MESSAGE).toMatch(/Top up the Hubtel SMS wallet/)
    expect(HUBTEL_OUT_OF_FUNDS_MESSAGE).not.toMatch(/Disbursement/)
  })
})
