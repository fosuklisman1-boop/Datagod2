import { notifyWithdrawalCompleted } from "./withdrawal-hook"

vi.mock("@/lib/admin-actions", () => ({ notifyUserOfOutcome: vi.fn(async () => []) }))
import { notifyUserOfOutcome } from "@/lib/admin-actions"

function fakeDb(shop: unknown, opts: { throws?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    from(table: string) {
      calls.push(table)
      const q: any = {
        select: () => q,
        eq: () => q,
        single: async () => {
          if (opts.throws) throw new Error("db down")
          return { data: shop, error: null }
        },
      }
      return q
    },
  }
}

beforeEach(() => vi.mocked(notifyUserOfOutcome).mockClear())

describe("notifyWithdrawalCompleted", () => {
  it("looks up the shop owner and sends the completed message with reference", async () => {
    const db = fakeDb({ user_id: "u1", shop_name: "Kofi Shop" })
    await notifyWithdrawalCompleted(db as any, {
      id: "w1", shop_id: "s1", amount: "25.5", withdrawal_method: "mobile_money", account_details: { phone: "0241112222" },
    })
    expect(db.calls).toEqual(["user_shops"])
    expect(notifyUserOfOutcome).toHaveBeenCalledWith(
      "withdrawal", "completed",
      { userId: "u1", reference: "w1" },
      { withdrawalId: "w1", amount: 25.5, shopName: "Kofi Shop", method: "mobile_money", phone: "0241112222" },
    )
  })
  it("falls back to network / account_number and tolerates missing details", async () => {
    await notifyWithdrawalCompleted(fakeDb({ user_id: "u1", shop_name: null }) as any, {
      id: "w2", shop_id: "s1", amount: 10, account_details: { network: "MTN", account_number: "123" },
    })
    expect(notifyUserOfOutcome).toHaveBeenCalledWith("withdrawal", "completed", { userId: "u1", reference: "w2" },
      { withdrawalId: "w2", amount: 10, shopName: null, method: "MTN", phone: "123" })
    vi.mocked(notifyUserOfOutcome).mockClear()
    await notifyWithdrawalCompleted(fakeDb({ user_id: "u1", shop_name: "S" }) as any, { id: "w3", shop_id: "s1", amount: 1 })
    expect(notifyUserOfOutcome).toHaveBeenCalledWith("withdrawal", "completed", { userId: "u1", reference: "w3" },
      { withdrawalId: "w3", amount: 1, shopName: "S", method: null, phone: null })
  })
  it("does nothing when the shop is missing or has no id/shop_id", async () => {
    await notifyWithdrawalCompleted(fakeDb(null) as any, { id: "w1", shop_id: "s1", amount: 1 })
    const db = fakeDb({ user_id: "u1" })
    await notifyWithdrawalCompleted(db as any, { id: "w1", shop_id: null, amount: 1 })
    expect(db.calls).toEqual([])
    expect(notifyUserOfOutcome).not.toHaveBeenCalled()
  })
  it("never throws", async () => {
    await expect(notifyWithdrawalCompleted(fakeDb(null, { throws: true }) as any, { id: "w1", shop_id: "s1", amount: 1 })).resolves.toBeUndefined()
    vi.mocked(notifyUserOfOutcome).mockRejectedValueOnce(new Error("boom"))
    await expect(notifyWithdrawalCompleted(fakeDb({ user_id: "u" }) as any, { id: "w1", shop_id: "s1", amount: 1 })).resolves.toBeUndefined()
  })
})
