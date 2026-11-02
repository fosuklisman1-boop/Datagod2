import { describe, it, expect, vi, beforeEach } from "vitest"
import type { LiveFacts } from "./live-facts"

const state = vi.hoisted(() => ({ headers: {} as Record<string, string>, facts: null as LiveFacts | null }))

vi.mock("next/headers", () => ({ headers: async () => new Headers(state.headers) }))
vi.mock("./live-facts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live-facts")>()
  return { ...actual, getLiveFacts: async () => state.facts as LiveFacts }
})

import { assertProductFactsLoaded } from "./product-status"
import { buildLiveFacts, FAILED_RAW, FALLBACK_FACTS, LiveFactsUnavailableError } from "./live-facts"

const main = (path: string) => ({ host: "www.datagod.store", "x-site-kind": "main", "x-request-path": path })

describe("assertProductFactsLoaded (root-layout status gate)", () => {
  beforeEach(() => {
    state.headers = {}
    state.facts = buildLiveFacts(FAILED_RAW)
  })

  it("throws (-> 500) on a template product page whose source failed", async () => {
    state.headers = main("/pay-dstv")
    state.facts = buildLiveFacts(FAILED_RAW, ["bills"])
    await expect(assertProductFactsLoaded()).rejects.toBeInstanceOf(LiveFactsUnavailableError)
  })

  it("throws for data pages when the packages read failed", async () => {
    state.headers = main("/mtn-data/")
    state.facts = FALLBACK_FACTS
    await expect(assertProductFactsLoaded()).rejects.toThrow(/mtn-data/)
  })

  it("passes an off product (complete read): the page renders 200 with a notice", async () => {
    state.headers = main("/pay-dstv")
    await expect(assertProductFactsLoaded()).resolves.toBeUndefined()
  })

  it("passes pages that are not template product pages", async () => {
    state.facts = FALLBACK_FACTS
    for (const path of ["/", "/services", "/join", "/bulk-sms", "/developers", "/dashboard"]) {
      state.headers = main(path)
      await expect(assertProductFactsLoaded(), path).resolves.toBeUndefined()
    }
  })

  it("throws for a landing page when its packages read failed, passes when it is off", async () => {
    state.headers = main("/data-bundle-prices")
    state.facts = FALLBACK_FACTS
    await expect(assertProductFactsLoaded()).rejects.toThrow(/data-bundle-prices/)
    state.facts = buildLiveFacts({ ...FAILED_RAW, packages: [] })
    await expect(assertProductFactsLoaded()).resolves.toBeUndefined()
  })

  it("passes off the main host (product pages 404 there anyway)", async () => {
    state.facts = FALLBACK_FACTS
    state.headers = { host: "kofi.datagod.store", "x-site-kind": "shop", "x-request-path": "/mtn-data" }
    await expect(assertProductFactsLoaded()).resolves.toBeUndefined()
  })
})
