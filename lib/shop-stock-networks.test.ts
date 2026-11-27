import { describe, it, expect } from "vitest"
import { mergeStockedOutNetworks, noticesForShop } from "./shop-stock-networks"

describe("mergeStockedOutNetworks", () => {
  it("adds a network the shop sells that the admin marked out of stock", () => {
    expect(mergeStockedOutNetworks(["Telecel"], ["Telecel", "MTN"], { MTN: "x" })).toEqual(["Telecel", "MTN"])
  })
  it("never adds a network the shop does not sell", () => {
    expect(mergeStockedOutNetworks(["Telecel"], ["Telecel"], { MTN: "x" })).toEqual(["Telecel"])
  })
  it("does not duplicate a network already listed", () => {
    expect(mergeStockedOutNetworks(["MTN"], ["MTN"], { MTN: "x" })).toEqual(["MTN"])
  })
  it("leaves out a sold network that is unavailable for another reason (no notice)", () => {
    expect(mergeStockedOutNetworks([], ["MTN"], {})).toEqual([])
  })
  it("matches the notice across spellings", () => {
    expect(mergeStockedOutNetworks([], ["AT - iShare"], { "AT-iShare": "x" })).toEqual(["AT - iShare"])
  })
})

describe("noticesForShop", () => {
  it("keeps only the notices for networks the shop sells", () => {
    expect(noticesForShop(["MTN"], { MTN: "x", Telecel: "y" })).toEqual({ MTN: "x" })
  })
  it("is empty when the shop sells none of the out-of-stock networks", () => {
    expect(noticesForShop(["Telecel"], { MTN: "x" })).toEqual({})
  })
})
