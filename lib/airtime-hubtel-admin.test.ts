import { describe, it, expect } from "vitest"
import {
  AIRTIME_SEND_GRACE_MS, airtimeSendDecision, appendPriorNotes, executeAirtimeHubtelSend, fetchAirtimeLedgerByOrders,
  hasLiveHubtelAttempt, type AirtimeSendDeps, type AirtimeSendOrder,
} from "./airtime-hubtel-admin"
import type { LedgerFact } from "./bills/admin"

const OLD = "2026-01-01T00:00:00Z"
const ord = (o: Partial<AirtimeSendOrder> = {}): AirtimeSendOrder => ({
  id: "o1", reference_code: "AIR-1", network: "MTN", beneficiary_phone: "0240000001", airtime_amount: 10,
  status: "pending", payment_status: "completed", notes: null, updated_at: OLD, ...o,
})
const row = (state: LedgerFact["state"] = "failed", o: Partial<LedgerFact> = {}): LedgerFact =>
  ({ client_reference: "RX", state, refund_claimed_at: null, resolved_by: null, created_at: "", ...o })

const R = {
  notEligible: "Only paid, pending airtime can be sent",
  notFailed: "A Hubtel transaction for this order is not failed; resolve it in Hubtel Commission first",
  refund: "A refund was already claimed for this order",
  override: "An attempt was marked failed by an admin override, not by Hubtel; it may have been delivered",
  dgw: "Digiwapy already accepted this order (dgwRef); check Digiwapy before resending",
  grace: "This order was updated moments ago and may still be dispatching; try again in a few minutes",
  dgwUnclear: "A Digiwapy attempt ended unclear (timeout/server error); it may have been delivered. Check Digiwapy before resending",
}

describe("airtimeSendDecision dispatch grace", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  it("exports a 3-minute grace", () => {
    expect(AIRTIME_SEND_GRACE_MS).toBe(180_000)
  })
  it("refuses an order updated 10s ago", () => {
    expect(airtimeSendDecision(ord({ updated_at: new Date(now - 10_000).toISOString() }), [], now)).toEqual({ ok: false, reason: R.grace })
  })
  it("allows an order exactly at the grace boundary", () => {
    expect(airtimeSendDecision(ord({ updated_at: new Date(now - AIRTIME_SEND_GRACE_MS).toISOString() }), [], now)).toEqual({ ok: true })
  })
  it("refuses an unparseable updated_at", () => {
    expect(airtimeSendDecision(ord({ updated_at: "not a date" }), [], now)).toEqual({ ok: false, reason: R.grace })
  })
  it("refuses a missing updated_at", () => {
    expect(airtimeSendDecision(ord({ updated_at: undefined as any }), [], now)).toEqual({ ok: false, reason: R.grace })
  })
  it("still reports the status reason first for a fresh non-pending order", () => {
    expect(airtimeSendDecision(ord({ status: "completed", updated_at: new Date(now).toISOString() }), [], now)).toEqual({ ok: false, reason: R.notEligible })
  })
})

describe("airtimeSendDecision Digiwapy unclear notes", () => {
  for (const notes of [
    "Digiwapy error: The operation was aborted",
    "Digiwapy error: Request timeout",
    "Digiwapy error: request timed out after 30s",
    "Digiwapy error: HTTP 502",
    "Digiwapy error: http 500 Internal Server Error",
    "Digiwapy error: Unexpected token < in JSON at position 0",
    "digiwapy ERROR: invalid json body",
  ]) {
    it(`refuses "${notes}"`, () => {
      expect(airtimeSendDecision(ord({ notes }), [])).toEqual({ ok: false, reason: R.dgwUnclear })
    })
  }
  it('allows a plain "Digiwapy error: fetch failed"', () => {
    expect(airtimeSendDecision(ord({ notes: "Digiwapy error: fetch failed" }), [])).toEqual({ ok: true })
  })
  it("allows a Digiwapy 4xx-style rejection", () => {
    expect(airtimeSendDecision(ord({ notes: "Digiwapy error: HTTP 400 insufficient balance" }), [])).toEqual({ ok: true })
  })
  it("keeps the dgwRef reason ahead of the unclear-note reason", () => {
    expect(airtimeSendDecision(ord({ notes: "Admin retry via Digiwapy [dgwRef:x] | prev: Digiwapy error: timeout" }), [])).toEqual({ ok: false, reason: R.dgw })
  })
})

describe("hasLiveHubtelAttempt", () => {
  it("false for no rows or only failed rows", () => {
    expect(hasLiveHubtelAttempt([])).toBe(false)
    expect(hasLiveHubtelAttempt([row("failed"), row("failed")])).toBe(false)
  })
  for (const state of ["created", "pending", "needs_review", "fulfilled"] as const) {
    it(`true when a row is ${state}`, () => {
      expect(hasLiveHubtelAttempt([row("failed"), row(state)])).toBe(true)
    })
  }
})

describe("appendPriorNotes", () => {
  it("returns the new note when there were no prior notes", () => {
    expect(appendPriorNotes("Sent via Hubtel [hcsRef:R1]", null)).toBe("Sent via Hubtel [hcsRef:R1]")
    expect(appendPriorNotes("Sent via Hubtel [hcsRef:R1]", "  ")).toBe("Sent via Hubtel [hcsRef:R1]")
  })
  it("appends the prior notes", () => {
    expect(appendPriorNotes("Sent via Hubtel [hcsRef:R1]", "Digiwapy error: fetch failed")).toBe("Sent via Hubtel [hcsRef:R1] | prev: Digiwapy error: fetch failed")
  })
  it("caps the result at 900 chars, keeping the new note intact", () => {
    const out = appendPriorNotes("NEW", "x".repeat(2000))
    expect(out.length).toBe(900)
    expect(out.startsWith("NEW | prev: ")).toBe(true)
  })
})

describe("airtimeSendDecision", () => {
  it("allows a paid pending order that never reached Hubtel", () => {
    expect(airtimeSendDecision(ord(), [])).toEqual({ ok: true })
  })
  it("allows a paid pending order whose only Hubtel attempt failed, with a Digiwapy fetch error note", () => {
    expect(airtimeSendDecision(ord({ notes: "Digiwapy error: fetch failed" }), [row("failed")])).toEqual({ ok: true })
  })
  for (const status of ["completed", "processing", "refunding", "refunded", "failed"]) {
    it(`refuses status ${status}`, () => {
      expect(airtimeSendDecision(ord({ status }), [])).toEqual({ ok: false, reason: R.notEligible })
    })
  }
  it("refuses an unpaid order", () => {
    expect(airtimeSendDecision(ord({ payment_status: "pending" }), [])).toEqual({ ok: false, reason: R.notEligible })
  })
  for (const state of ["needs_review", "pending", "fulfilled"] as const) {
    it(`refuses a ledger row in state ${state}`, () => {
      expect(airtimeSendDecision(ord(), [row("failed"), row(state)])).toEqual({ ok: false, reason: R.notFailed })
    })
  }
  it("refuses when a refund was claimed", () => {
    expect(airtimeSendDecision(ord(), [row("failed", { refund_claimed_at: "2026-10-26T00:00:00Z" })])).toEqual({ ok: false, reason: R.refund })
  })
  it("refuses an admin-overridden failure", () => {
    expect(airtimeSendDecision(ord(), [row("failed", { resolved_by: "admin-1" })])).toEqual({ ok: false, reason: R.override })
  })
  it("refuses when Digiwapy accepted it once (dgwRef in notes)", () => {
    expect(airtimeSendDecision(ord({ notes: "Sent via Digiwapy [dgwRef:abc]" }), [])).toEqual({ ok: false, reason: R.dgw })
  })
})

function make(o: {
  order?: AirtimeSendOrder | null
  after?: AirtimeSendOrder | null
  ledger?: () => Promise<LedgerFact[]>
  send?: () => Promise<boolean>
} = {}) {
  const calls: string[] = []
  const sent: AirtimeSendOrder[] = []
  const alerts: { message: string; urgent?: boolean }[] = []
  let didSend = false
  const first = o.order === undefined ? ord() : o.order
  const d: AirtimeSendDeps = {
    getOrder: async () => { calls.push("getOrder"); return didSend && o.after !== undefined ? o.after : first },
    getLedger: async () => { calls.push("getLedger"); return o.ledger ? o.ledger() : [] },
    send: async (order) => { calls.push("send"); sent.push(order); didSend = true; return o.send ? o.send() : true },
    alert: async (message, urgent) => { calls.push("alert"); alerts.push({ message, urgent }) },
  }
  return { d, calls, sent, alerts }
}

describe("executeAirtimeHubtelSend", () => {
  it("404 when the order is missing", async () => {
    const { d, calls } = make({ order: null })
    expect(await executeAirtimeHubtelSend(d, "o1")).toMatchObject({ ok: false, status: 404 })
    expect(calls).not.toContain("send")
  })
  it("409 with the decision reason and no send when refused", async () => {
    const { d, calls } = make({ order: ord({ status: "completed" }) })
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 409, message: R.notEligible })
    expect(calls).not.toContain("send")
  })
  it("503 and no send when the ledger cannot be read", async () => {
    const { d, calls } = make({ ledger: async () => { throw new Error("db down") } })
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" })
    expect(calls).not.toContain("send")
  })
  it("503 and no send when the second ledger read throws", async () => {
    let n = 0
    const { d, calls } = make({ ledger: async () => { if (n++ === 0) return []; throw new Error("db down") } })
    expect((await executeAirtimeHubtelSend(d, "o1")).status).toBe(503)
    expect(calls).not.toContain("send")
  })
  it("happy path: sends once with the fresh order and reports the re-read status", async () => {
    const fresh = ord()
    const { d, calls, sent } = make({ order: fresh, after: ord({ status: "processing" }) })
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({
      ok: true, status: 200, orderStatus: "processing", message: "Sent to Hubtel; the order is processing",
    })
    expect(sent).toEqual([fresh])
    expect(calls).toEqual(["getOrder", "getLedger", "getLedger", "getOrder", "send", "getOrder"])
  })
  it("re-reads the order after the second ledger read and refuses if it flipped to refunding", async () => {
    const { d, calls } = make()
    let n = 0
    d.getOrder = async () => { calls.push("getOrder"); return n++ === 0 ? ord() : ord({ status: "refunding" }) }
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 409, message: R.notEligible })
    expect(calls).toEqual(["getOrder", "getLedger", "getLedger", "getOrder"])
  })
  it("refuses with 409 when the order vanished on the pre-send re-read", async () => {
    const { d, calls } = make()
    let n = 0
    d.getOrder = async () => { calls.push("getOrder"); return n++ === 0 ? ord() : null }
    expect(await executeAirtimeHubtelSend(d, "o1")).toMatchObject({ ok: false, status: 404 })
    expect(calls).not.toContain("send")
  })
  it("sends the re-read order, not the first read", async () => {
    const { d, sent } = make()
    let n = 0
    d.getOrder = async () => (n++ === 0 ? ord() : ord({ notes: "re-read" }))
    await executeAirtimeHubtelSend(d, "o1")
    expect(sent[0].notes).toBe("re-read")
  })
  it("uses the injected clock for the dispatch grace (409, no send)", async () => {
    const now = Date.parse("2026-10-26T12:00:00Z")
    const { d, calls } = make({ order: ord({ updated_at: new Date(now - 5_000).toISOString() }) })
    d.now = () => now
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 409, message: R.grace })
    expect(calls).not.toContain("send")
  })
  it("defaults to the real clock: an order updated just now is refused", async () => {
    const { d, calls } = make({ order: ord({ updated_at: new Date().toISOString() }) })
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 409, message: R.grace })
    expect(calls).not.toContain("send")
  })
  it("not sent: reports the order notes and leaves the order alone", async () => {
    const notes = 'Hubtel: not sent - unsupported network "GLO". Fulfil manually.'
    const { d, calls } = make({ send: async () => false, after: ord({ notes }) })
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 200, orderStatus: "pending", message: `Not sent: ${notes}` })
    expect(calls.filter(c => c === "send")).toHaveLength(1)
    expect(calls).not.toContain("alert")
  })
  it("re-reads the ledger after the first decision and refuses if a non-failed row appeared", async () => {
    let n = 0
    const { d, calls } = make({ ledger: async () => (n++ === 0 ? [] : [row("pending")]) })
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 409, message: R.notFailed })
    expect(calls).toEqual(["getOrder", "getLedger", "getLedger", "getOrder"])
  })
  it("send throws: 500 and an urgent do-not-resend alert naming the reference", async () => {
    const { d, alerts } = make({ send: async () => { throw new Error("boom") } })
    const r = await executeAirtimeHubtelSend(d, "o1")
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(alerts).toHaveLength(1)
    expect(alerts[0].urgent).toBe(true)
    expect(alerts[0].message).toContain("AIR-1")
    expect(alerts[0].message).toContain("do not resend")
  })
  it("send throws and the alert also throws: still 500", async () => {
    const { d } = make({ send: async () => { throw new Error("boom") } })
    d.alert = async () => { throw new Error("alert down") }
    expect((await executeAirtimeHubtelSend(d, "o1")).status).toBe(500)
  })
  it("happy path survives a failed re-read of the order", async () => {
    const { d } = make()
    let n = 0
    const orig = d.getOrder
    d.getOrder = async (id) => { if (n++ < 2) return orig(id); throw new Error("db down") }
    expect(await executeAirtimeHubtelSend(d, "o1")).toMatchObject({ ok: true, status: 200 })
  })
  it("503 and no send when the pre-send order re-read throws", async () => {
    const { d, calls } = make()
    let n = 0
    const orig = d.getOrder
    d.getOrder = async (id) => { if (n++ === 0) return orig(id); throw new Error("db down") }
    expect(await executeAirtimeHubtelSend(d, "o1")).toEqual({ ok: false, status: 503, message: "Could not re-read the order; try again" })
    expect(calls).not.toContain("send")
  })
})

describe("fetchAirtimeLedgerByOrders", () => {
  function fakeDb(rows: any[], error: any = null) {
    const seen: { table?: string; eq?: [string, string]; inLens: number[] } = { inLens: [] }
    const db: any = {
      from(table: string) {
        seen.table = table
        const q: any = {
          select: () => q,
          eq: (c: string, v: string) => { seen.eq = [c, v]; return q },
          in: (_c: string, ids: string[]) => { seen.inLens.push(ids.length); q._ids = ids; return q },
          order: async () => ({ data: error ? null : rows.filter(r => q._ids.includes(r.order_id)), error }),
        }
        return q
      },
    }
    return { db, seen }
  }
  it("groups rows by order and filters on airtime_orders", async () => {
    const { db, seen } = fakeDb([
      { order_id: "a", client_reference: "R1", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "2" },
      { order_id: "a", client_reference: "R2", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "1" },
      { order_id: "b", client_reference: "R3", state: "pending", refund_claimed_at: null, resolved_by: null, created_at: "1" },
    ])
    const m = await fetchAirtimeLedgerByOrders(db, ["a", "b", "c"])
    expect(seen.table).toBe("hubtel_cs_transactions")
    expect(seen.eq).toEqual(["order_table", "airtime_orders"])
    expect(m.get("a")?.map(r => r.client_reference)).toEqual(["R1", "R2"])
    expect(m.get("b")?.[0].state).toBe("pending")
    expect(m.get("c")).toBeUndefined()
  })
  it("returns an empty map for no ids", async () => {
    const { db } = fakeDb([])
    expect((await fetchAirtimeLedgerByOrders(db, [])).size).toBe(0)
  })
  it("throws on a DB error", async () => {
    const { db } = fakeDb([], { message: "boom" })
    await expect(fetchAirtimeLedgerByOrders(db, ["a"])).rejects.toBeTruthy()
  })
  it("reads every id in chunks (never silently drops ids past 200)", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`)
    const { db, seen } = fakeDb([{ order_id: "id449", client_reference: "RZ", state: "pending", refund_claimed_at: null, resolved_by: null, created_at: "1" }])
    const m = await fetchAirtimeLedgerByOrders(db, ids)
    expect(seen.inLens).toEqual([200, 200, 50])
    expect(m.get("id449")?.[0].state).toBe("pending")
  })
})
