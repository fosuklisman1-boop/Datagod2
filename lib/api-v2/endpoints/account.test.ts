import { describe, it, expect, vi } from "vitest"
import { mapRole, mapBalance, readBalance } from "./account"

const ctxOf = (environment: "test" | "live") => ({
  keyId: "k",
  userId: "user-9",
  role: "dealer",
  keyType: "standard" as const,
  environment,
  firstName: null,
})

function fakeWallets(result: { data: any; error: any }) {
  const eq = vi.fn(() => ({ single: async () => result }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { client: { from }, from, eq }
}

describe("readBalance", () => {
  it("test env uses only the sandbox", async () => {
    const w = fakeWallets({ data: null, error: null })
    const sandboxBalance = vi.fn(async () => 100)
    const r = await readBalance(ctxOf("test"), { wallets: w.client, sandboxBalance })
    expect(r).toEqual({ status: 200, data: { balance: 100, currency: "GHS", sandbox: true } })
    expect(sandboxBalance).toHaveBeenCalledWith("user-9")
    expect(w.from).not.toHaveBeenCalled()
  })

  it("live env reads wallets for ctx.userId and never the sandbox", async () => {
    const w = fakeWallets({ data: { balance: 12.345, total_credited: 20, total_spent: 7.655 }, error: null })
    const sandboxBalance = vi.fn(async () => 0)
    const r = await readBalance(ctxOf("live"), { wallets: w.client, sandboxBalance })
    expect(w.from).toHaveBeenCalledWith("wallets")
    expect(w.eq).toHaveBeenCalledWith("user_id", "user-9")
    expect(sandboxBalance).not.toHaveBeenCalled()
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ balance: 12.35, currency: "GHS" })
  })

  it("wallet error or missing wallet gives generic 500", async () => {
    for (const result of [
      { data: null, error: { message: "pg secret detail" } },
      { data: null, error: null },
    ]) {
      const w = fakeWallets(result)
      const r = await readBalance(ctxOf("live"), { wallets: w.client, sandboxBalance: vi.fn() })
      expect(r.status).toBe(500)
      expect(r.error).toEqual({ status: 500, message: "Failed to fetch wallet balance" })
      expect(JSON.stringify(r)).not.toContain("secret")
    }
  })
})

describe("account mappers", () => {
  it("mapRole", () => {
    expect(
      mapRole({
        keyId: "k",
        userId: "u",
        role: "dealer",
        keyType: "standard",
        environment: "live",
        firstName: null,
      })
    ).toEqual({ role: "dealer", key_type: "standard", environment: "live" })
  })

  it("mapBalance rounds to 2dp", () => {
    expect(mapBalance({ balance: 12.345, total_credited: 20, total_spent: 7.655 })).toEqual({
      balance: 12.35,
      total_credited: 20,
      total_spent: 7.66,
      currency: "GHS",
    })
  })

  it("mapBalance null", () => {
    expect(mapBalance(null)).toBeNull()
  })
})
