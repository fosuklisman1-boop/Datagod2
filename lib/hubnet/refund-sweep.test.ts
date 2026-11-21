import { describe, it, expect, vi } from "vitest"
import { sweepHubnetRefunds } from "./refund-sweep"

const mk = (kind: "DG" | "DA", n: string) => `${kind}${n.repeat(22)}`

function makeDb(tracking: any[], airtime: any[]) {
  const writes: any[] = []
  const from = (table: string) => {
    const f: Array<[string, any]> = []
    let op = "select"
    let payload: any
    const rows = () => {
      const src = table === "airtime_orders" ? airtime : tracking
      return src.filter((r) => f.every(([c, v]) => {
        if (c === "ilike") return String(r.notes ?? "").includes(v)
        return r[c] === v
      }))
    }
    const b: any = {
      select: () => b,
      update: (p: any) => ((op = "update"), (payload = p), b),
      eq: (c: string, v: any) => (f.push([c, v]), b),
      ilike: (_c: string, v: string) => (f.push(["ilike", v.replace(/%/g, "")]), b),
      limit: () => b,
      then: (res: any, rej: any) => {
        const matched = rows()
        if (op === "update") {
          if (matched.length) { matched.forEach((r) => Object.assign(r, payload)); writes.push({ table, payload }) }
          return Promise.resolve({ data: matched, error: null }).then(res, rej)
        }
        return Promise.resolve({ data: matched, error: null }).then(res, rej)
      },
    }
    return b
  }
  return { db: { from } as any, writes }
}

const DG = mk("DG", "1")
const DA = mk("DA", "2")
const client = (items: any[] | null) => ({ listRefunds: vi.fn(async () => items) }) as any

function deps(tracking: any[]) {
  return {
    apply: vi.fn(async (_db: any, row: any, st: string, _r?: any) => { const r = tracking.find((t) => t.id === row.id)!; r.status = st; return true }),
    flag: vi.fn(async (_db: any, row: any, _p?: any) => { tracking.find((t) => t.id === row.id)!.status = "reversed"; return { flagged: true, superseded: false } }),
  }
}

describe("sweepHubnetRefunds", () => {
  it("fails a pending data attempt", async () => {
    const tracking = [{ id: "t1", mtn_order_id: DG, provider: "hubnet", status: "processing" }]
    const { db } = makeDb(tracking, [])
    const d = deps(tracking); const alert = vi.fn(async (..._a: any[]) => {})
    const r = await sweepHubnetRefunds(db, client([{ reference: DG }]), alert, d)
    expect(r.dataFailed).toBe(1)
    expect(d.apply.mock.calls[0][2]).toBe("failed")
    expect(d.apply.mock.calls[0][3]).toEqual({ status: "refunded", message: "Hubnet refunded this attempt" })
  })

  it("flags a completed data attempt and alerts per ref", async () => {
    const tracking = [{ id: "t1", mtn_order_id: DG, provider: "hubnet", status: "completed" }]
    const { db } = makeDb(tracking, [])
    const d = deps(tracking); const alert = vi.fn(async (..._a: any[]) => {})
    const r = await sweepHubnetRefunds(db, client([{ reference: DG }]), alert, d)
    expect(r.dataReversed).toBe(1)
    expect(d.flag.mock.calls[0][2]).toEqual({ status: "refunded", message: "Hubnet refunded a completed order" })
    expect(alert.mock.calls[0][0]).toBe(`hubnet_refund_reversed:${DG}`)
    expect(alert.mock.calls[0][4]).toBe(7 * 24 * 3600 * 1000)
  })

  it("skips reversed, failed, abandoned and missing rows", async () => {
    const tracking = ["reversed", "failed", "abandoned"].map((s, i) => ({ id: `t${i}`, mtn_order_id: DG, provider: "hubnet", status: s }))
    for (const t of tracking) {
      const { db } = makeDb([t], [])
      const d = deps([t]); const alert = vi.fn(async (..._a: any[]) => {})
      await sweepHubnetRefunds(db, client([{ reference: DG }]), alert, d)
      expect(d.apply).not.toHaveBeenCalled(); expect(d.flag).not.toHaveBeenCalled(); expect(alert).not.toHaveBeenCalled()
    }
    const { db } = makeDb([], [])
    const d = deps([]); const alert = vi.fn(async (..._a: any[]) => {})
    await sweepHubnetRefunds(db, client([{ reference: DG }]), alert, d)
    expect(alert).not.toHaveBeenCalled()
  })

  it("airtime processing: marker + pending + alert", async () => {
    const airtime = [{ id: "a1", status: "processing", notes: `x [hubnetRef:${DA}]` }]
    const { db } = makeDb([], airtime)
    const alert = vi.fn(async (..._a: any[]) => {})
    const r = await sweepHubnetRefunds(db, client([{ reference: DA }]), alert, deps([]))
    expect(r.airtimeFlagged).toBe(1)
    expect(airtime[0].status).toBe("pending")
    expect(airtime[0].notes).toBe(`x [hubnetRef:${DA}] [hubnetRefunded]`)
    expect(alert.mock.calls[0][0]).toBe(`airtime_hubnet_refunded:${DA}`)
  })

  it("airtime completed: marker only", async () => {
    const airtime = [{ id: "a1", status: "completed", notes: `[hubnetRef:${DA}]` }]
    const { db } = makeDb([], airtime)
    const alert = vi.fn(async (..._a: any[]) => {})
    await sweepHubnetRefunds(db, client([{ reference: DA }]), alert, deps([]))
    expect(airtime[0].status).toBe("completed")
    expect(airtime[0].notes).toContain("[hubnetRefunded]")
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it("unparseable refs: count + one summary alert, no writes, no phones", async () => {
    const { db, writes } = makeDb([], [])
    const alert = vi.fn(async (..._a: any[]) => {})
    const r = await sweepHubnetRefunds(db, client([{ phone: "0240000001" }, { reference: "junk" }]), alert, deps([]))
    expect(r.reviewOnly).toBe(2)
    expect(writes).toEqual([])
    expect(alert).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(alert.mock.calls[0])).not.toContain("0240000001")
    expect(alert.mock.calls[0][4]).toBe(24 * 3600 * 1000)
  })

  it("alert text reflects what was written (processing vs completed vs other)", async () => {
    for (const [status, want, notWant] of [
      ["processing", "set back to pending", null],
      ["completed", "Order is completed", "set back to pending"],
      ["pending", "status unchanged", "set back to pending"],
    ] as const) {
      const airtime = [{ id: "a1", status, notes: `[hubnetRef:${DA}]` }]
      const { db } = makeDb([], airtime)
      const alert = vi.fn(async (..._a: any[]) => {})
      await sweepHubnetRefunds(db, client([{ reference: DA }]), alert, deps([]))
      expect(alert.mock.calls[0][2]).toContain(want)
      if (notWant) expect(alert.mock.calls[0][2]).not.toContain(notWant)
    }
  })

  it("second sweep is a no-op", async () => {
    const tracking = [{ id: "t1", mtn_order_id: DG, provider: "hubnet", status: "completed" }]
    const airtime = [{ id: "a1", status: "processing", notes: `[hubnetRef:${DA}]` }]
    const { db, writes } = makeDb(tracking, airtime)
    const d = deps(tracking); const alert = vi.fn(async (..._a: any[]) => {})
    const items = [{ reference: DG }, { reference: DA }]
    await sweepHubnetRefunds(db, client(items), alert, d)
    const w = writes.length, a = alert.mock.calls.length, f = d.flag.mock.calls.length
    await sweepHubnetRefunds(db, client(items), alert, d)
    expect(writes.length).toBe(w); expect(alert.mock.calls.length).toBe(a); expect(d.flag.mock.calls.length).toBe(f)
  })

  it("listRefunds null gives zeros", async () => {
    const { db } = makeDb([], [])
    const r = await sweepHubnetRefunds(db, client(null), vi.fn(async (..._a: any[]) => {}), deps([]))
    expect(r).toEqual({ seen: 0, dataFailed: 0, dataReversed: 0, airtimeFlagged: 0, reviewOnly: 0 })
  })
})
