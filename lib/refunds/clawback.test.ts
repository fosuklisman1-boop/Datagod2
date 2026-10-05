import { planClawback, type OwnerCut } from "./clawback"

const owner = (o: Partial<OwnerCut> = {}): OwnerCut => ({
  shopId: "s1", ownerUserId: "u1", credited: 10, pending: 0,
  availableBalance: 100, walletBalance: 0, ...o,
})

describe("planClawback", () => {
  it("takes everything from profit when the available balance covers it", () => {
    const plan = planClawback([owner()])
    expect(plan.ok).toBe(true)
    expect(plan.lines[0]).toMatchObject({ fromProfit: 10, fromWallet: 0, shortfall: 0 })
  })

  it("falls back to the wallet for the part profit cannot cover", () => {
    const plan = planClawback([owner({ availableBalance: 4, walletBalance: 20 })])
    expect(plan.lines[0]).toMatchObject({ fromProfit: 4, fromWallet: 6, shortfall: 0 })
    expect(plan.ok).toBe(true)
  })

  it("reports a shortfall when profit + wallet together cannot cover it", () => {
    const plan = planClawback([owner({ availableBalance: 4, walletBalance: 2 })])
    expect(plan.ok).toBe(false)
    expect(plan.lines[0]).toMatchObject({ fromProfit: 4, fromWallet: 6, shortfall: 4 })
  })

  it("treats a negative available balance and negative wallet as zero capacity", () => {
    const plan = planClawback([owner({ availableBalance: -5, walletBalance: -3 })])
    expect(plan.lines[0]).toMatchObject({ fromProfit: 0, fromWallet: 10, shortfall: 10 })
    expect(plan.ok).toBe(false)
  })

  it("blocks the whole plan when only the parent owner is short (sub-agent order)", () => {
    const plan = planClawback([
      owner({ shopId: "sub", credited: 5, availableBalance: 50 }),
      owner({ shopId: "parent", ownerUserId: "u2", credited: 3, availableBalance: 0, walletBalance: 0 }),
    ])
    expect(plan.ok).toBe(false)
    expect(plan.lines.find((l) => l.shopId === "sub")!.shortfall).toBe(0)
    expect(plan.lines.find((l) => l.shopId === "parent")!.shortfall).toBe(3)
  })

  it("does not need balance for the pending (not yet credited) portion", () => {
    const plan = planClawback([owner({ credited: 0, pending: 7, availableBalance: 0, walletBalance: 0 })])
    expect(plan.ok).toBe(true)
    expect(plan.lines[0]).toMatchObject({ fromProfit: 0, fromWallet: 0, pending: 7 })
  })

  it("avoids floating point drift", () => {
    const plan = planClawback([owner({ credited: 0.3, availableBalance: 0.1, walletBalance: 0.2 })])
    expect(plan.lines[0]).toMatchObject({ fromProfit: 0.1, fromWallet: 0.2, shortfall: 0 })
  })

  it("orders lines by shop id so lock order is deterministic", () => {
    const plan = planClawback([owner({ shopId: "b" }), owner({ shopId: "a" })])
    expect(plan.lines.map((l) => l.shopId)).toEqual(["a", "b"])
  })
})
