import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ openPricedShop: vi.fn() }))
vi.mock("./open-shop", () => ({ openPricedShop: h.openPricedShop }))

import { openClosedJoinerAfterSave } from "./open-after-save"

const JOINER = { joined_via: "storefront", is_active: false, prices_set_at: null, parent_shop_id: "p1" }
const db = {} as any

beforeEach(() => { h.openPricedShop.mockReset() })

describe("openClosedJoinerAfterSave", () => {
  it("a closed joiner's save opens the shop and returns the links", async () => {
    h.openPricedShop.mockResolvedValue({ status: "opened", ussdCode: "4321", subdomain: "kofi" })
    expect(await openClosedJoinerAfterSave(db, "u1", JOINER)).toEqual({ opened: true, ussdCode: "4321", subdomain: "kofi" })
    expect(h.openPricedShop).toHaveBeenCalledWith(db, "u1")
  })

  it.each([
    ["an invite sub-agent", { ...JOINER, joined_via: null }],
    ["a main shop", { joined_via: null, is_active: true, prices_set_at: null, parent_shop_id: null }],
    ["an open joiner", { ...JOINER, is_active: true }],
    ["a joiner already priced", { ...JOINER, prices_set_at: "2026-11-01" }],
  ])("%s never calls open", async (_n, shop) => {
    expect(await openClosedJoinerAfterSave(db, "u1", shop)).toEqual({})
    expect(h.openPricedShop).not.toHaveBeenCalled()
  })

  it("no_prices or blocked: not opened, no error", async () => {
    h.openPricedShop.mockResolvedValue({ status: "no_prices" })
    expect(await openClosedJoinerAfterSave(db, "u1", JOINER)).toEqual({ opened: false })
  })

  it("an open failure never throws", async () => {
    h.openPricedShop.mockImplementation(async () => { throw new Error("db down") })
    expect(await openClosedJoinerAfterSave(db, "u1", JOINER)).toEqual({ opened: false })
  })
})
