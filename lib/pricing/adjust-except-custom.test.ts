import { describe, it, expect } from "vitest"
import { applyAdjustmentsExceptCustom } from "./adjust-except-custom"

const markup = async (pkgs: any[]) => pkgs.map((p) => ({ ...p, price: p.price * 2 }))
const pkgs = [{ id: "a", price: 10 }, { id: "b", price: 5 }, { id: "c", price: 1 }]

describe("applyAdjustmentsExceptCustom", () => {
  it("skips custom ids and keeps order", async () => {
    expect(await applyAdjustmentsExceptCustom(pkgs, ["b"], markup)).toEqual([
      { id: "a", price: 20 }, { id: "b", price: 5 }, { id: "c", price: 2 },
    ])
  })
  it("adjusts everything when no custom ids", async () => {
    expect((await applyAdjustmentsExceptCustom(pkgs, [], markup)).map((p) => p.price)).toEqual([20, 10, 2])
  })
})
