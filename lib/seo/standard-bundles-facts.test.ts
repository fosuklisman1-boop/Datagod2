import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { telecelNoExpiryOffered } from "./standard-bundles-facts"
import { resolveBundlesConfig } from "@/lib/standard-bundles/config"
import { resolveConfig } from "@/lib/hubtel-cs/config"

const bundles = (telecel: Record<string, unknown> = {}, enabled = true) =>
  resolveBundlesConfig({
    enabled,
    networks: { TELECEL: { enabled: true, hiddenCategories: [], referenceNumber: "0200000000", ...telecel } },
  })
const hubtel = (over: Record<string, unknown> = {}) => resolveConfig({ enabled: true, services: { data_telecel: true }, ...over })

describe("telecelNoExpiryOffered", () => {
  it("is true only when bundles, Telecel, Hubtel and data_telecel are all on and the category is visible", () => {
    expect(telecelNoExpiryOffered(bundles(), hubtel())).toBe(true)
  })

  it("is false when any switch is off, the category is hidden or Hubtel is paused", () => {
    expect(telecelNoExpiryOffered(bundles({}, false), hubtel())).toBe(false)
    expect(telecelNoExpiryOffered(bundles({ enabled: false }), hubtel())).toBe(false)
    expect(telecelNoExpiryOffered(bundles({ hiddenCategories: ["No Expiry"] }), hubtel())).toBe(false)
    expect(telecelNoExpiryOffered(bundles(), hubtel({ enabled: false }))).toBe(false)
    expect(telecelNoExpiryOffered(bundles(), hubtel({ paused: true }))).toBe(false)
    expect(telecelNoExpiryOffered(bundles(), hubtel({ services: { data_telecel: false } }))).toBe(false)
  })
})
