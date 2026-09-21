import { computePackagePriceUpdate, type BulkPriceUpdates, type PackagePriceInput } from "@/lib/bulk-package-pricing"

const basePkg: PackagePriceInput = { id: "pkg-1", price: 20, dealer_price: 18, size: "5" }

describe("computePackagePriceUpdate — percentage mode", () => {
  it("increases price by a positive percentage", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: 10 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(22)
    expect(result.skip_reason).toBeNull()
  })

  it("decreases price with a negative percentage", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -10 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(18)
  })

  it("rounds to 2 decimal places", () => {
    const pkg: PackagePriceInput = { ...basePkg, price: 19.99 }
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: 7 } }
    const result = computePackagePriceUpdate(pkg, updates)
    // 19.99 * 1.07 = 21.3893 -> 21.39
    expect(result.new_price).toBe(21.39)
  })

  it("leaves price untouched when price field is not in updates", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: 5 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(basePkg.price)
  })
})

describe("computePackagePriceUpdate — per_gb mode", () => {
  it("sets price to size(GB) * rate, replacing the old price", () => {
    const updates: BulkPriceUpdates = { price: { mode: "per_gb", value: 4.5 } }
    const result = computePackagePriceUpdate(basePkg, updates) // size "5" -> 5GB
    expect(result.new_price).toBe(22.5)
  })

  it("ignores the old price entirely in per_gb mode", () => {
    const pkg: PackagePriceInput = { ...basePkg, price: 999 }
    const updates: BulkPriceUpdates = { price: { mode: "per_gb", value: 2 } }
    const result = computePackagePriceUpdate(pkg, updates)
    expect(result.new_price).toBe(10) // 5GB * 2, not derived from 999
  })

  it("treats a non-numeric size as 0GB (resulting price is non-positive and gets skipped)", () => {
    const pkg: PackagePriceInput = { ...basePkg, size: "unlimited" }
    const updates: BulkPriceUpdates = { price: { mode: "per_gb", value: 4.5 } }
    const result = computePackagePriceUpdate(pkg, updates)
    expect(result.new_price).toBe(0)
    expect(result.skip_reason).toBe("non_positive_price")
  })
})

describe("computePackagePriceUpdate — dealer_price handling", () => {
  it("updates dealer_price independently of price", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: 10 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_dealer_price).toBe(19.8) // 18 * 1.1
    expect(result.new_price).toBe(basePkg.price) // untouched
  })

  it("falls back to price as the dealer_price base when dealer_price is null", () => {
    const pkg: PackagePriceInput = { ...basePkg, dealer_price: null }
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: 10 } }
    const result = computePackagePriceUpdate(pkg, updates)
    expect(result.new_dealer_price).toBe(22) // 20 (price) * 1.1, not 0 * 1.1
  })

  it("can update both price and dealer_price in one call with different modes", () => {
    const updates: BulkPriceUpdates = {
      price: { mode: "per_gb", value: 5 },
      dealer_price: { mode: "percentage", value: -5 },
    }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(25) // 5GB * 5
    expect(result.new_dealer_price).toBe(17.1) // 18 * 0.95
  })
})

describe("computePackagePriceUpdate — safeguards", () => {
  it("skips when the computed price would be zero or negative", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -150 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.skip_reason).toBe("non_positive_price")
  })

  it("skips when the computed dealer_price would be zero or negative", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: -150 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.skip_reason).toBe("non_positive_dealer_price")
  })

  it("skips when the new dealer_price would exceed the new price", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "per_gb", value: 100 } }
    const result = computePackagePriceUpdate(basePkg, updates) // dealer becomes 500, price stays 20
    expect(result.skip_reason).toBe("dealer_price_exceeds_price")
  })

  it("does not flag dealer_price_exceeds_price when dealer_price isn't being updated and was already <= price", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -1 } } // 20 -> 19.8, dealer stays 18
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.skip_reason).toBeNull()
  })

  it("returns old values unchanged alongside the skip reason (caller decides whether to apply)", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -150 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.old_price).toBe(20)
    expect(result.old_dealer_price).toBe(18)
  })

  it("skips with non_finite_value instead of silently succeeding when value is NaN", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: Number.NaN } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.skip_reason).toBe("non_finite_value")
  })

  it("skips a price-only update as dealer_price_exceeds_price when the untouched dealer_price newly exceeds the lowered price", () => {
    const pkg: PackagePriceInput = { ...basePkg, price: 20, dealer_price: 18 }
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -50 } } // 20 -> 10, dealer stays 18
    const result = computePackagePriceUpdate(pkg, updates)
    expect(result.new_price).toBe(10)
    expect(result.new_dealer_price).toBe(18)
    expect(result.skip_reason).toBe("dealer_price_exceeds_price")
  })
})
