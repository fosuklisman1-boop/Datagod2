// lib/hubtel-cs/adapters/data-orders.bots.test.ts
// A USSD buyer has no wallet and gets no notification: when Hubtel fails a bot row AFTER the POST returned pending, an
// URGENT admin alert is their only protection. Driven from the callback through the real hook and the real adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearOrderAdapters, notifyAdapter, registerOrderAdapter } from "../adapters"
import { processCallback, signRef } from "../callback"
import { makeOrderHook } from "../order-hook"
import { makeTx } from "../testing/fixtures"
import { createMemoryStore } from "../testing/memory-store"
import { createDataOrdersAdapter, dataOrdersAdapterFor } from "./data-orders"

const h = vi.hoisted(() => ({ notifyAdmins: vi.fn(async (..._a: unknown[]) => {}) }))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: h.notifyAdmins }))

type Row = Record<string, any>
const REF = "HCS-data_mtn-REF1"
const SECRET = "s3cret"
const PHONE = "233241234567"

const row = (o: Row = {}): Row => ({
  id: "c2", reference_code: "SB-2", status: "processing", payment_status: "paid", user_id: null, channel: "bots",
  network: "MTN", bundle_display: "406MB", beneficiary_phone: PHONE, amount: 5, paid_amount: 5.07,
  special_group_id: "g-1", special_index: 2, ...o,
})
const sibling = (i: number): Row => row({ id: `c${i}`, reference_code: `SB-${i}`, special_index: i, status: "pending" })

/** Filter-aware PostgREST fake; `failReads` makes the order read fail, `failCount` the group count. */
function fakeDb(rows: Row[], fail: { failReads?: boolean; failCount?: boolean } = {}) {
  return {
    from() {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null
      const hit = () => rows.filter(r => filters.every(f => f(r)))
      const q: any = {
        select: () => {
          if (!patch) return q
          const changed = hit()
          for (const r of changed) Object.assign(r, patch)
          return Promise.resolve({ data: changed.map(r => ({ id: r.id })), error: null })
        },
        update: (p: Row) => { patch = p; return q },
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q },
        in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q },
        maybeSingle: async () => (fail.failReads
          ? { data: null, error: { message: "read failed" } }
          : { data: hit()[0] ?? null, error: null }),
        then: (res: any, rej: any) => Promise.resolve(fail.failCount
          ? { count: null, error: { message: "count failed" } }
          : { count: hit().length, error: null }).then(res, rej),
      }
      return q
    },
  } as any
}

function rig(rows: Row[], fail: { failReads?: boolean; failCount?: boolean } = {}, orderId = "c2") {
  const store = createMemoryStore()
  store.seed(makeTx({ state: "pending", client_reference: REF, order_table: "hubtel_data_orders", order_id: orderId, service_key: "data_mtn" }))
  registerOrderAdapter(dataOrdersAdapterFor(fakeDb(rows, fail)))
  const onTransition = makeOrderHook({ store, notify: notifyAdapter, alertReview: async () => {} })
  const callback = (code = "2001", description: string | null = `Number ${PHONE} rejected`) => processCallback(
    { store, secret: SECRET, enforceIp: false, onTransition },
    {
      ref: REF, sig: signRef(REF, SECRET), ip: null,
      rawBody: JSON.stringify({ ResponseCode: code, Data: { ClientReference: REF, ...(description ? { Description: description } : {}) } }),
    },
  )
  return { store, callback }
}
const alerts = () => h.notifyAdmins.mock.calls.map(c => String(c[0]))

beforeEach(() => { h.notifyAdmins.mockReset(); h.notifyAdmins.mockImplementation(async () => {}) })
afterEach(() => { clearOrderAdapters(); vi.restoreAllMocks() })

describe("a bot row failed by Hubtel's callback", () => {
  it("a Special unit: URGENT with the email fallback, naming the group, unit i/N, reference and Hubtel code", async () => {
    const rows = [sibling(1), row(), sibling(3)]
    const out = await rig(rows).callback("2001")
    expect(out.status).toBe(200)
    expect(rows[1]).toMatchObject({ status: "failed" })
    expect(alerts()).toHaveLength(1)
    const m = alerts()[0]
    expect(m).toMatch(/^URGENT/)
    for (const part of ["g-1", "unit 2/3", "SB-2", "code 2001", "Admin > Refunds", "deliver by hand"]) expect(m).toContain(part)
    expect(h.notifyAdmins.mock.calls[0][3]).toBe(false) // false = keep the email fallback
  })

  it("never carries Hubtel's raw description or the recipient's number", async () => {
    await rig([sibling(1), row()]).callback("2001", `Number ${PHONE} rejected`)
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]).not.toContain(PHONE)
    expect(alerts()[0]).not.toContain("rejected")
  })

  it("a single bot row: names the order reference and the code, with no group wording", async () => {
    const rows = [row({ id: "o1", reference_code: "SB-9", special_group_id: null, special_index: null })]
    await rig(rows, {}, "o1").callback("2001")
    expect(alerts()).toHaveLength(1)
    const m = alerts()[0]
    expect(m).toMatch(/^URGENT/)
    expect(m).toContain("SB-9")
    expect(m).toContain("code 2001")
    expect(m).not.toContain("Special group")
    expect(h.notifyAdmins.mock.calls[0][3]).toBe(false)
  })

  it("a repeated callback sends nothing more", async () => {
    const { callback } = rig([row()])
    await callback()
    await callback()
    expect(alerts()).toHaveLength(1)
  })

  it("the group size read failing still alerts, naming the unit without a size", async () => {
    await rig([row()], { failCount: true }).callback("2001")
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]).toContain("g-1")
    expect(alerts()[0]).toMatch(/unit 2\b/)
  })

  it("the order read failing after the update still alerts, naming the order id and the code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await rig([row()], { failReads: true }).callback("2001")
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]).toMatch(/^URGENT/)
    expect(alerts()[0]).toContain("c2")
    expect(alerts()[0]).toContain("code 2001")
  })

  it("an alert failure is logged and never breaks callback processing; the ledger row is still synced", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    h.notifyAdmins.mockImplementation(async () => { throw new Error("sms down") })
    const rows = [row()]
    const { callback, store } = rig(rows)
    expect((await callback()).status).toBe(200)
    expect(rows[0].status).toBe("failed")
    expect((await store.getByRef(REF))?.order_synced_at).toBeTruthy()
    expect(log).toHaveBeenCalled()
  })
})

describe("onFailed scope", () => {
  const deps = (o: Row, n = 1) => {
    const alertAdmin = vi.fn(async () => {})
    const notify = vi.fn(async () => {})
    return {
      alertAdmin, notify,
      adapter: createDataOrdersAdapter({
        get: async () => o as any, update: async () => n, creditWallet: async () => {}, notify, alertAdmin, groupSize: async () => 3,
      }),
    }
  }
  const tx = () => makeTx({ state: "failed", order_id: "o1", response_code: "2001" })

  it("a row that did not change sends nothing (the cron re-notify sweep re-runs this hook)", async () => {
    const d = deps(row(), 0)
    await d.adapter.onFailed(tx())
    expect(d.alertAdmin).not.toHaveBeenCalled()
  })

  it("a dashboard row is told as today and raises no admin alert, even in a Special group", async () => {
    const d = deps(row({ channel: "dashboard", user_id: "u1" }))
    await d.adapter.onFailed(tx())
    expect(d.notify).toHaveBeenCalledWith("u1", "Standard bundle failed", expect.stringContaining("under review"), "o1")
    expect(d.alertAdmin).not.toHaveBeenCalled()
  })

  it("a storefront row raises no admin alert", async () => {
    const d = deps(row({ channel: "storefront", special_group_id: null, special_index: null }))
    await d.adapter.onFailed(tx())
    expect(d.notify).not.toHaveBeenCalled()
    expect(d.alertAdmin).not.toHaveBeenCalled()
  })
})
