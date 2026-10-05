import { recordPayerPhone } from "./payer-phone"

function fakeDb(opts: { insertError?: { code?: string; message: string }; updateError?: { message: string }; throwOnUpdate?: boolean }) {
  const calls: unknown[][] = []
  const db: any = {
    from: (t: string) => ({
      insert: async (rows: unknown) => { calls.push([t, "insert", rows]); return { error: opts.insertError ?? null } },
      update: (v: unknown) => ({
        eq: async (c: string, val: string) => {
          calls.push([t, "update", v, c, val])
          if (opts.throwOnUpdate) throw new Error("boom")
          return { error: opts.updateError ?? null }
        },
      }),
    }),
  }
  return { db, calls }
}

const base = { reference: "WALLET-1", rawPhone: "+233 24 111 2222", baseRow: { reference: "WALLET-1" } }

describe("recordPayerPhone", () => {
  it("inserts the base row then writes the normalised number in a separate update", async () => {
    const { db, calls } = fakeDb({})
    await recordPayerPhone(db, base)
    expect(calls).toEqual([
      ["payment_attempts", "insert", [{ reference: "WALLET-1" }]],
      ["payment_attempts", "update", { payer_phone: "0241112222" }, "reference", "WALLET-1"],
    ])
  })

  it("does nothing for an invalid number", async () => {
    const { db, calls } = fakeDb({})
    await recordPayerPhone(db, { ...base, rawPhone: "12345" })
    expect(calls).toEqual([])
  })

  it("never throws: missing column, insert error or exception are swallowed", async () => {
    await expect(recordPayerPhone(fakeDb({ updateError: { message: "column payer_phone does not exist" } }).db, base)).resolves.toBeUndefined()
    await expect(recordPayerPhone(fakeDb({ insertError: { code: "23505", message: "dup" } }).db, base)).resolves.toBeUndefined()
    await expect(recordPayerPhone(fakeDb({ throwOnUpdate: true }).db, base)).resolves.toBeUndefined()
  })
})
