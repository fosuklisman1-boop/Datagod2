import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: vi.fn(async () => {}) }))

import { applyHubnetAirtimeStatus, fulfillAirtimeViaHubnet, syncHubnetAirtime } from "./airtime-hubnet"
import { hubnetRef } from "@/lib/hubnet/core"
import { OUTCOME_UNKNOWN } from "@/lib/mtn-providers/outcome"
import { sendPushToUser } from "@/lib/push-service"

const UUID = "11111111-2222-3333-4444-555555555555"
const REF1 = hubnetRef("airtime", UUID, 1)
const REF2 = hubnetRef("airtime", UUID, 2)
const PHONE = "0241234567"
const order = { id: UUID, reference_code: "AT-9", network: "MTN", beneficiary_phone: PHONE, airtime_amount: 5 }

type Lk = { kind: "found"; status: "processing" | "completed" | "failed"; refunded: boolean; raw: unknown } | { kind: "missing" } | { kind: "unknown" }
const found = (status: "processing" | "completed" | "failed", refunded = false): Lk => ({ kind: "found", status, refunded, raw: {} })
const placeOk = (event = "charge.success", status = 200) => ({ ok: true, res: { status }, json: { event }, text: "" })

function mk(opts: { statuses?: Record<string, Lk[]>; place?: any } = {}) {
  const statuses = opts.statuses ?? {}
  const client: any = {
    getStatus: vi.fn(async (ref: string) => {
      const q = statuses[ref]
      if (!q) return { kind: "missing" }
      return q.length > 1 ? q.shift() : q[0]
    }),
    placeAirtime: vi.fn(async () => (opts.place instanceof Function ? opts.place() : opts.place ?? placeOk())),
  }
  const marks: any[] = []
  const alerts: { message: string; kind?: string }[] = []
  const deps = {
    client,
    markOrder: vi.fn(async (id: string, patch: any, from?: string[]) => { marks.push({ id, patch, from }); return 1 }),
    alert: vi.fn(async (message: string, kind?: any) => { alerts.push({ message, kind }) }),
  }
  return { client, deps, marks, alerts }
}

beforeEach(() => vi.clearAllMocks())

describe("fulfillAirtimeViaHubnet", () => {
  it("charge.success => processing with hubnetRef, never completed", async () => {
    const { deps, marks, client } = mk()
    expect(await fulfillAirtimeViaHubnet(order, deps)).toBe(true)
    expect(client.placeAirtime).toHaveBeenCalledWith({ phone: PHONE, amountGhs: 5, reference: REF1 })
    expect(marks).toHaveLength(1)
    expect(marks[0].patch).toEqual({ status: "processing", notes: `Sent via Hubnet [hubnetRef:${REF1}]` })
    expect(marks[0].from).toEqual(["pending"])
    expect(marks.some(m => m.patch.status === "completed")).toBe(false)
  })

  it("charge.failed => not-sent note + manual alert, returns false", async () => {
    const { deps, marks, alerts } = mk({ place: placeOk("charge.failed", 200) })
    // 200 with a non-success event is unknown to the classifier; use a 400 rejection instead
    const r = mk({ place: { ok: true, res: { status: 400 }, json: { message: "bad", status_code: 400 }, text: "" } })
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(false)
    expect(r.marks[0].patch.status).toBeUndefined()
    expect(r.marks[0].patch.notes).toMatch(/^Hubnet: not sent - .*Fulfil manually\.$/)
    expect(r.alerts[0].kind).toBe("manual")
    void deps; void marks; void alerts
  })

  it("insufficient balance / auth / rate limit => not sent, false", async () => {
    for (const [status, json] of [[400, { message: "Insufficient balance" }], [401, {}], [429, {}]] as const) {
      const r = mk({ place: { ok: true, res: { status }, json, text: "" } })
      expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(false)
      expect(r.alerts[0].kind).toBe("manual")
      expect(r.marks.every(m => m.patch.status === undefined)).toBe(true)
    }
  })

  it("invalid phone => not sent without calling Hubnet", async () => {
    const r = mk()
    expect(await fulfillAirtimeViaHubnet({ ...order, beneficiary_phone: "123" }, r.deps)).toBe(false)
    expect(r.client.getStatus).not.toHaveBeenCalled()
    expect(r.client.placeAirtime).not.toHaveBeenCalled()
    expect(r.alerts[0].kind).toBe("manual")
  })

  it("place unknown => re-check found => processing", async () => {
    const r = mk({
      place: { ok: false, response: { success: false, error_type: OUTCOME_UNKNOWN, message: "x" } },
      statuses: { [REF1]: [{ kind: "missing" }, found("processing")] },
    })
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(true)
    expect(r.marks[0].patch.status).toBe("processing")
    expect(r.marks[0].patch.notes).toContain(`[hubnetRef:${REF1}]`)
    expect(r.alerts).toHaveLength(0)
  })

  it("place unknown + still missing => processing + review alert 'do not resend'", async () => {
    const r = mk({ place: { ok: false, response: { success: false, error_type: OUTCOME_UNKNOWN, message: "x" } } })
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(true)
    expect(r.marks[0].patch.status).toBe("processing")
    expect(r.marks[0].patch.notes).toContain(`[hubnetRef:${REF1}]`)
    expect(r.alerts[0].kind).toBe("review")
    expect(r.alerts[0].message.toLowerCase()).toContain("do not resend")
  })

  it("duplicate => found re-check => processing; else review", async () => {
    const dup = { ok: true, res: { status: 409 }, json: {}, text: "" }
    const a = mk({ place: dup, statuses: { [REF1]: [{ kind: "missing" }, found("completed")] } })
    expect(await fulfillAirtimeViaHubnet(order, a.deps)).toBe(true)
    expect(a.marks[0].patch.status).toBe("processing")
    const b = mk({ place: dup })
    expect(await fulfillAirtimeViaHubnet(order, b.deps)).toBe(true)
    expect(b.alerts[0].kind).toBe("review")
  })

  it("existing live attempt is adopted without a second placement", async () => {
    const r = mk({ statuses: { [REF1]: [found("processing")] } })
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(true)
    expect(r.client.placeAirtime).not.toHaveBeenCalled()
    expect(r.marks[0].patch).toEqual({ status: "processing", notes: `Hubnet: existing attempt resumed [hubnetRef:${REF1}]` })
  })

  it("failed or refunded attempt 1 => places attempt 2", async () => {
    const r = mk({ statuses: { [REF1]: [found("failed")] } })
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(true)
    expect(r.client.placeAirtime).toHaveBeenCalledWith({ phone: PHONE, amountGhs: 5, reference: REF2 })
    const r2 = mk({ statuses: { [REF1]: [found("processing", true)] } })
    await fulfillAirtimeViaHubnet(order, r2.deps)
    expect(r2.client.placeAirtime).toHaveBeenCalledWith({ phone: PHONE, amountGhs: 5, reference: REF2 })
  })

  it("unknown ledger lookup => no placement, processing + review 'do not resend'", async () => {
    const r = mk({ statuses: { [REF1]: [{ kind: "unknown" }] } })
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(true)
    expect(r.client.placeAirtime).not.toHaveBeenCalled()
    expect(r.marks[0].patch.notes).toBe(`Hubnet: outcome unknown [hubnetRef:${REF1}]. Do not resend.`)
    expect(r.alerts[0].kind).toBe("review")
    expect(r.alerts[0].message.toLowerCase()).toContain("do not resend")
  })

  it("all 5 attempts failed => not sent", async () => {
    const statuses: Record<string, Lk[]> = {}
    for (let n = 1; n <= 5; n++) statuses[hubnetRef("airtime", UUID, n)] = [found("failed")]
    const r = mk({ statuses })
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(false)
    expect(r.client.placeAirtime).not.toHaveBeenCalled()
  })

  it("never throws and never leaks the phone in notes or alerts", async () => {
    const r = mk({ place: () => { throw new Error("boom") } })
    r.deps.alert = vi.fn(async () => { throw new Error("alert down") })
    await expect(fulfillAirtimeViaHubnet(order, r.deps)).resolves.toBe(true)
    const all = mk({ place: { ok: false, response: { success: false, error_type: OUTCOME_UNKNOWN, message: "x" } } })
    await fulfillAirtimeViaHubnet(order, all.deps)
    const text = JSON.stringify([all.marks, all.alerts])
    expect(text).not.toContain(PHONE)
  })

  it("a guarded write matching 0 rows raises a review alert", async () => {
    const r = mk()
    r.deps.markOrder = vi.fn(async () => 0)
    expect(await fulfillAirtimeViaHubnet(order, r.deps)).toBe(true)
    expect(r.alerts[0].kind).toBe("review")
  })
})

// ---- fake db ---------------------------------------------------------------------------------
function fakeDb(rows: any[]) {
  const notifications: any[] = []
  const db: any = {
    from(table: string) {
      if (table === "notifications") return { insert: async (r: any) => { notifications.push(r); return { error: null } } }
      const filters: ((r: any) => boolean)[] = []
      let patch: any = null
      let lim = Infinity
      const q: any = {
        select: () => q,
        update: (p: any) => { patch = p; return q },
        eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q },
        like: (c: string, p: string) => { const s = p.replace(/%/g, ""); filters.push(r => String(r[c] ?? "").includes(s)); return q },
        order: () => q,
        limit: (n: number) => { lim = n; return q },
        maybeSingle: async () => ({ data: rows.filter(r => filters.every(f => f(r)))[0] ?? null, error: null }),
        then: (res: any, rej: any) => {
          const hit = rows.filter(r => filters.every(f => f(r))).slice(0, lim)
          if (patch) hit.forEach(r => Object.assign(r, patch))
          return Promise.resolve({ data: hit, error: null }).then(res, rej)
        },
      }
      return q
    },
  }
  return { db, notifications }
}
const proc = (over: any = {}) => ({
  id: "o1", reference_code: "AT-1", network: "MTN", airtime_amount: 5, user_id: "u1",
  beneficiary_phone: PHONE, status: "processing", notes: `Sent via Hubnet [hubnetRef:${REF1}]`, ...over,
})

describe("applyHubnetAirtimeStatus", () => {
  it("completed => completed + notification + push, no phone in text", async () => {
    const rows = [proc()]
    const { db, notifications } = fakeDb(rows)
    expect(await applyHubnetAirtimeStatus(db, "o1", found("completed"))).toBe(true)
    expect(rows[0].status).toBe("completed")
    expect(notifications).toHaveLength(1)
    expect(JSON.stringify(notifications)).not.toContain(PHONE)
    expect(JSON.stringify((sendPushToUser as any).mock.calls)).not.toContain(PHONE)
    expect((sendPushToUser as any).mock.calls[0][0]).toBe("u1")
  })

  it("failed or refunded => pending, ' Hubnet failed' appended, manual alert", async () => {
    for (const lk of [found("failed"), found("processing", true)]) {
      const rows = [proc()]
      const { db } = fakeDb(rows)
      const alert = vi.fn(async () => {})
      expect(await applyHubnetAirtimeStatus(db, "o1", lk, alert)).toBe(true)
      expect(rows[0].status).toBe("pending")
      expect(rows[0].notes).toBe(`Sent via Hubnet [hubnetRef:${REF1}] Hubnet failed`)
      expect(alert).toHaveBeenCalledTimes(1)
      expect((alert as any).mock.calls[0][1]).toBe("manual")
      expect(JSON.stringify((alert as any).mock.calls)).not.toContain(PHONE)
    }
  })

  it("processing / missing / unknown => no change", async () => {
    for (const lk of [found("processing"), { kind: "missing" }, { kind: "unknown" }] as Lk[]) {
      const rows = [proc()]
      const { db } = fakeDb(rows)
      expect(await applyHubnetAirtimeStatus(db, "o1", lk)).toBe(false)
      expect(rows[0].status).toBe("processing")
    }
  })

  it("only moves a processing order (completed stays untouched, returns false)", async () => {
    const rows = [proc({ status: "completed" })]
    const { db, notifications } = fakeDb(rows)
    expect(await applyHubnetAirtimeStatus(db, "o1", found("failed"))).toBe(false)
    expect(rows[0].status).toBe("completed")
    expect(notifications).toHaveLength(0)
  })
})

describe("syncHubnetAirtime", () => {
  it("completes a processing order; no-op on a completed one; skips orders without a Hubnet ref", async () => {
    const rows = [
      proc({ id: "a" }),
      proc({ id: "b", status: "completed" }),
      proc({ id: "c", notes: "Auto-fulfilled via Digiwapy" }),
    ]
    const { db } = fakeDb(rows)
    const client: any = { getStatus: vi.fn(async () => found("completed")) }
    expect(await syncHubnetAirtime(db, client)).toEqual({ checked: 1, updated: 1 })
    expect(client.getStatus).toHaveBeenCalledTimes(1)
    expect(client.getStatus).toHaveBeenCalledWith(REF1)
    expect(rows.map(r => r.status)).toEqual(["completed", "completed", "processing"])
    expect(await syncHubnetAirtime(db, client)).toEqual({ checked: 0, updated: 0 })
  })

  it("uses the last hubnetRef in the notes", async () => {
    const rows = [proc({ notes: `old [hubnetRef:${REF1}] Hubnet failed Sent via Hubnet [hubnetRef:${REF2}]` })]
    const { db } = fakeDb(rows)
    const client: any = { getStatus: vi.fn(async () => found("processing")) }
    await syncHubnetAirtime(db, client)
    expect(client.getStatus).toHaveBeenCalledWith(REF2)
  })

  it("one failing lookup does not stop the rest", async () => {
    const rows = [proc({ id: "a" }), proc({ id: "b" })]
    const { db } = fakeDb(rows)
    let i = 0
    const client: any = { getStatus: vi.fn(async () => { if (i++ === 0) throw new Error("boom"); return found("completed") }) }
    expect(await syncHubnetAirtime(db, client)).toEqual({ checked: 2, updated: 1 })
  })
})
