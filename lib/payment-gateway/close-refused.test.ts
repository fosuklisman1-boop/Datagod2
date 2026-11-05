import { describe, expect, it, vi } from "vitest"
import { closeRefusedHubtelWalletPayment } from "./close-refused"

function fakeDb(opts: { attempts?: any[]; lookupError?: boolean; updateError?: boolean } = {}) {
  const updates: { patch: any; filters: [string, string, unknown][] }[] = []
  const from = (table: string) => {
    const filters: [string, string, unknown][] = []
    let patch: any = null
    const q: any = {
      select: () => q,
      update: (p: any) => ((patch = p), q),
      eq: (k: string, v: unknown) => (filters.push(["eq", k, v]), q),
      in: (k: string, v: unknown) => (filters.push(["in", k, v]), q),
      then: (res: any, rej: any) => {
        if (table === "hubtel_payments") {
          return Promise.resolve(opts.lookupError ? { data: null, error: { code: "XX000", message: "down" } } : { data: opts.attempts ?? [], error: null }).then(res, rej)
        }
        updates.push({ patch, filters })
        return Promise.resolve(opts.updateError ? { data: null, error: { message: "down" } } : { data: [{ id: "wp1" }], error: null }).then(res, rej)
      },
    }
    return q
  }
  return { db: { from } as any, updates }
}

const attempt = (status: string) => ({ reference: "a".repeat(32), internal_reference: "WALLET-1", status, amount_pesewas: 100, created_at: "2026-11-05T00:00:00Z" })

describe("closeRefusedHubtelWalletPayment", () => {
  it("no Hubtel attempt: the pending Hubtel row is failed, guarded on pending + hubtel", async () => {
    const { db, updates } = fakeDb()
    expect(await closeRefusedHubtelWalletPayment(db, "WALLET-1")).toBe("closed")
    expect(updates).toHaveLength(1)
    expect(updates[0].patch.status).toBe("failed")
    expect(updates[0].filters).toEqual(expect.arrayContaining([
      ["eq", "reference", "WALLET-1"], ["eq", "status", "pending"], ["eq", "payment_method", "hubtel"],
    ]))
  })

  it("only refused/failed attempts: closed", async () => {
    const { db, updates } = fakeDb({ attempts: [attempt("failed")] })
    expect(await closeRefusedHubtelWalletPayment(db, "WALLET-1")).toBe("closed")
    expect(updates).toHaveLength(1)
  })

  it.each(["pending", "confirming", "paid", "needs_review"])("a %s attempt may hold money: left open", async (status) => {
    const { db, updates } = fakeDb({ attempts: [attempt(status)] })
    expect(await closeRefusedHubtelWalletPayment(db, "WALLET-1")).toBe("left_open")
    expect(updates).toHaveLength(0)
  })

  it("the attempt lookup fails: left open, never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { db, updates } = fakeDb({ lookupError: true })
    expect(await closeRefusedHubtelWalletPayment(db, "WALLET-1")).toBe("left_open")
    expect(updates).toHaveLength(0)
  })

  it("the update fails: reported, never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = fakeDb({ updateError: true })
    expect(await closeRefusedHubtelWalletPayment(db, "WALLET-1")).toBe("error")
  })
})
