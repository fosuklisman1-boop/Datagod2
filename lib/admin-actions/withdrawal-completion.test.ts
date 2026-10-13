import { applyWithdrawalCompletion } from "./withdrawal-hook"

vi.mock("@/lib/admin-actions", () => ({ notifyUserOfOutcome: vi.fn(async () => []) }))

function fakeDb(o: { condRows?: unknown[] | null; condError?: unknown; current?: { status: string } | null }) {
  const writes: { fields: any; conditional: boolean }[] = []
  return {
    writes,
    from() {
      let fields: any
      let conditional = false
      const q: any = {
        update: (f: any) => { fields = f; return q },
        eq: () => q,
        in: () => { conditional = true; return q },
        select: (cols?: string) => {
          if (fields) { writes.push({ fields, conditional }); return Promise.resolve({ data: o.condRows ?? null, error: o.condError ?? null }) }
          return q
        },
        maybeSingle: async () => ({ data: o.current ?? null, error: null }),
        then: (res: any) => { writes.push({ fields, conditional }); return Promise.resolve({ error: null }).then(res) },
      }
      return q
    },
  }
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

describe("applyWithdrawalCompletion", () => {
  it("matched row -> notify, one conditional write", async () => {
    const db = fakeDb({ condRows: [{ id: "w1" }] })
    const r = await applyWithdrawalCompletion(db as any, "w1", { paystack_fee: 1 }, ["processing"])
    expect(r.shouldNotify).toBe(true)
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].fields).toMatchObject({ status: "completed", paystack_fee: 1 })
  })
  it("0 rows + already completed -> no write, no notify", async () => {
    const db = fakeDb({ condRows: [], current: { status: "completed" } })
    const r = await applyWithdrawalCompletion(db as any, "w1", {}, ["processing"])
    expect(r.shouldNotify).toBe(false)
    expect(db.writes).toHaveLength(1)
  })
  it("0 rows + other status -> unconditional write, CRITICAL log, notify", async () => {
    const db = fakeDb({ condRows: [], current: { status: "pending" } })
    const r = await applyWithdrawalCompletion(db as any, "w1", { moolre_fee: 2 }, ["processing"])
    expect(r.shouldNotify).toBe(true)
    expect(db.writes).toHaveLength(2)
    expect(db.writes[1].conditional).toBe(false)
    expect(db.writes[1].fields).toMatchObject({ status: "completed", moolre_fee: 2 })
    expect(console.error).toHaveBeenCalledWith("[WITHDRAWAL] CRITICAL: provider-confirmed completion applied over status=pending for w1")
  })
  it("DB error on the conditional write -> notify without a second write", async () => {
    const db = fakeDb({ condError: { message: "boom" } })
    const r = await applyWithdrawalCompletion(db as any, "w1", {}, ["processing"])
    expect(r.shouldNotify).toBe(true)
    expect(r.error).toBeTruthy()
    expect(db.writes).toHaveLength(1)
  })
})
