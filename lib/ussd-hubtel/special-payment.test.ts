// lib/ussd-hubtel/special-payment.test.ts
// One Hubtel payment for a whole Special Bundles group: all-or-nothing decision, N confirmations through the REAL
// shared engine (confirmBotOrder on fake deps, dispatch replaced by a queue) and the REAL dispatch loop, deferred.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { NextRequest } from "next/server"
import {
  BOT_NEEDS_REVIEW_PREFIX, createFailHandlers, createOrderHandlers, createPaidReviewHandlers, createPossiblyPaidAlerts, recordBotPaymentForReview, type ConfirmBotFn,
} from "./order-handlers"
import { specialGroupPostPayment, type ConfirmQueuedFn } from "./special-payment"
import { processFulfillment } from "./payment"
import { runStatusChecks } from "./status-check"
import { confirmBotOrder, type ConfirmDeps, type ConfirmResult } from "@/lib/storefront-commission/confirm"
import type { StorefrontOrderTable } from "@/lib/storefront-commission/payment"
import { dispatchSpecialGroup } from "@/lib/standard-bundles/special-service"
import type { BundlesDeps } from "@/lib/standard-bundles/service"
import { watchStuckSpecialGroups, specialStuckMessage } from "@/lib/standard-bundles/special-watch"
import { bundleCanDispatch } from "@/lib/standard-bundles/admin"
import { listPendingOrderRefs, loadRefundableOrders } from "@/lib/refunds/orders"
import { orderEligibility } from "@/lib/refunds/eligibility"
import { moolreGateway } from "@/lib/refunds/gateways/moolre"
import { hubtelGateway } from "@/lib/refunds/gateways/hubtel"
import type { HubtelFulfillmentInfo, HubtelTxRow, HubtelTxStore } from "./types"

const h = vi.hoisted(() => ({
  notifyAdmins: vi.fn(async (..._a: unknown[]) => {}),
  db: null as unknown,
}))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: h.notifyAdmins, sendSMS: vi.fn(async () => ({})), SMSTemplates: {} }))
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))
vi.mock("@/lib/hubtel-cs/runtime", () => ({ getHubtelCsRuntime: () => ({ db: h.db }) }))
vi.mock("@/lib/hubtel-cs/admin-route", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/hubtel-cs/admin-route")>()),
  requireAdmin: async () => ({ ok: true, userId: "admin1" }),
}))

type Row = Record<string, any>
const NOW = Date.parse("2026-11-07T12:00:00Z")
const TABLE = "hubtel_data_orders"
const GROUP = "g-1"

function child(i: number, o: Row = {}): Row {
  return {
    id: `c${i}`, reference_code: `SB-${i}`, special_group_id: GROUP, special_index: i, channel: "bots", bot_surface: "hubtel_ussd",
    network: "MTN", beneficiary_phone: "233241234567", bundle_value: "v", bundle_display: "406MB", bundle_category: "Special", amount: 5,
    shop_id: "shop1", user_id: null, paid_amount: 5.07, shop_share_amount: 0.15, buyer_phone: "233241234567",
    status: "pending", payment_status: "unpaid", payment_reference: null, hubtel_client_reference: null, notes: null,
    failure_reason: null, created_at: new Date(NOW - 60_000).toISOString(), updated_at: new Date(NOW - 60_000).toISOString(), ...o,
  }
}
const group = (n = 3, o: (i: number) => Row = () => ({})) => Array.from({ length: n }, (_, k) => child(k + 1, o(k + 1)))

function txRow(o: Partial<HubtelTxRow> = {}): HubtelTxRow {
  return {
    session_id: "S1", hubtel_order_id: null, platform: "USSD", order_table: TABLE, order_id: "c1",
    mobile: "233241234567", expected_amount: 15.21, amount_paid: null, amount_after_charges: null, state: "awaiting_payment",
    callback_status: "not_due", callback_attempts: 0, callback_last_error: null, callback_sent_at: null, review_reason: null,
    status_check_attempts: 0, last_status_check_at: null, paid_at: null, created_at: "", updated_at: "", ...o,
  } as HubtelTxRow
}
const paidTx = (o: Partial<HubtelTxRow> = {}) => txRow({ hubtel_order_id: "H1", paid_at: new Date(NOW).toISOString(), amount_after_charges: 15.21, ...o })

/** Filter-aware PostgREST fake (as order-handlers.bots.test.ts) with switchable read / update errors. */
function fakeDb(tables: Record<string, Row[]>, fail: { read?: (cols: string) => boolean; update?: (filterCols: string[]) => boolean } = {}) {
  const updates: Array<{ table: string; patch: Row; matched: number; on: string[] }> = []
  const client: any = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      const on: string[] = []
      let patch: Row | null = null
      let cols = ""
      let orderBy: { col: string; asc: boolean } | null = null
      let lim: number | null = null
      const rows = () => {
        let out = (tables[table] ?? []).filter(r => filters.every(f => f(r)))
        if (orderBy) {
          const { col, asc } = orderBy
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
        }
        return lim == null ? out : out.slice(0, lim)
      }
      const runUpdate = () => {
        if (fail.update?.(on)) return { data: null, error: { message: "update failed" } }
        const hit = rows()
        for (const r of hit) Object.assign(r, patch)
        updates.push({ table, patch: patch!, matched: hit.length, on })
        return { data: hit.map(r => ({ id: r.id, status: r.status })), error: null }
      }
      const readError = () => (fail.read?.(cols) ? { data: null, error: { message: "read failed" } } : null)
      const q: any = {
        select: (c: string) => { if (patch) return Promise.resolve(runUpdate()); cols = c; return q },
        update: (p: Row) => { patch = p; return q },
        eq: (c: string, v: unknown) => { on.push(c); filters.push(r => r[c] === v); return q },
        in: (c: string, vs: unknown[]) => { on.push(c); filters.push(r => vs.includes(r[c])); return q },
        not: (c: string, op: string, v: unknown) => {
          if (op !== "is" || v !== null) throw new Error("fake: unsupported not()")
          filters.push(r => r[c] != null); return q
        },
        order: (c: string, o?: { ascending?: boolean }) => { orderBy = { col: c, asc: o?.ascending !== false }; return q },
        limit: (n: number) => { lim = n; return q },
        maybeSingle: async () => {
          const bad = readError()
          if (bad) return bad
          const r = rows()[0]
          return { data: r ? { ...r } : null, error: null }
        },
        then: (res: any, rej: any) => Promise.resolve(patch ? runUpdate() : readError() ?? { data: rows().map(r => ({ ...r })), error: null }).then(res, rej),
      }
      return q
    },
  }
  return { client, updates }
}

/** The real engine and the real dispatch loop over the same in-memory rows. */
function rig(tables: Record<string, Row[]>, opts: { confirmResult?: (id: string, real: ConfirmResult) => ConfirmResult | Promise<ConfirmResult> } = {}) {
  const profits: Row[] = []
  const engineAlerts: string[] = []
  const posts: string[] = []
  const dispatchAlerts: string[] = []
  const rows = () => tables[TABLE] ?? []
  const find = (id: string) => rows().find(r => r.id === id) ?? null
  const d: ConfirmDeps = {
    async getOrder(_t, id) { const r = find(id); return r ? ({ ...r } as any) : null },
    async markPaid(_t, id, p) {
      const r = find(id)
      if (!r || r.channel !== "bots" || r.payment_status !== "unpaid") return { changed: 0, status: null }
      Object.assign(r, { payment_status: "paid", ...p })
      return { changed: 1, status: r.status }
    },
    async insertShopProfit(row) {
      if (profits.some(p => p.data_order_id === row.data_order_id)) throw Object.assign(new Error("dup"), { code: "23505" })
      profits.push(row)
    },
    billsAutoFulfil: async () => true,
    async dispatch() { throw new Error("the group path must never dispatch from inside the engine") },
    async setPendingNote() { return 0 },
    async hasLedgerRow() { return false },
    async alert(m) { engineAlerts.push(m) },
    now: () => NOW,
  }
  const confirmQueued: ConfirmQueuedFn = vi.fn(async (t: StorefrontOrderTable, id: string, p, queue: string[]) => {
    const real = await confirmBotOrder({ ...d, dispatch: async (_t, x) => { queue.push(x); return "pending" } }, t, id, p)
    return opts.confirmResult ? opts.confirmResult(id, real) : real
  })
  const bundles = {
    getOrder: async (id: string) => { const r = find(id); return r ? { ...r } : null },
    updateOrder: async (id: string, patch: Row, from?: string[], pay?: string) => {
      const r = find(id)
      if (!r || (from && !from.includes(r.status)) || (pay && r.payment_status !== pay)) return 0
      Object.assign(r, patch)
      return 1
    },
    purchase: async (input: { orderId: string }) => { posts.push(input.orderId); return { state: "pending", client_reference: `HCS-${input.orderId}` } },
    alert: async (m: string) => { dispatchAlerts.push(m) },
    now: () => NOW,
  } as unknown as BundlesDeps
  const dispatchGroup = vi.fn((g: string, ids: string[], n: number, startedAt: number) => dispatchSpecialGroup(bundles, g, ids, n, startedAt))
  const deferred: Array<() => Promise<void>> = []
  const defer = vi.fn((t: () => Promise<void>) => { deferred.push(t) })
  const runDeferred = async () => { for (const t of deferred.splice(0)) await t() }
  return { confirmQueued, dispatchGroup, defer, deferred, runDeferred, profits, posts, engineAlerts, dispatchAlerts, bundles }
}

function txStore(tables: Record<string, Row[]>): HubtelTxStore {
  const get = (sid: string) => (tables.hubtel_transactions ?? []).find(r => r.session_id === sid) as HubtelTxRow | undefined
  return {
    findBySession: async sid => { const r = get(sid); return r ? { ...r } : null },
    claim: async (sid, from = ["awaiting_payment"]) => {
      const r = get(sid)
      if (r && from.includes(r.state)) { r.state = "processing"; return true }
      return false
    },
    updateIf: async () => false,
    update: async (sid, patch) => { const r = get(sid); if (r) Object.assign(r, patch) },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => (tables.hubtel_transactions ?? []).filter(r => r.state === "awaiting_payment").map(r => ({ ...r }) as HubtelTxRow),
    listStaleProcessing: async () => (tables.hubtel_transactions ?? []).filter(r => r.state === "processing").map(r => ({ ...r }) as HubtelTxRow),
    listIndeterminate: async () => [],
  }
}

const paidInfo = (o: Partial<HubtelFulfillmentInfo> = {}): HubtelFulfillmentInfo =>
  ({ sessionId: "S1", hubtelOrderId: "H1", amountPaid: 15.6, amountAfterCharges: 15.21, isSuccessful: true, ...o })

const urgent = () => h.notifyAdmins.mock.calls.map(c => String(c[0]))
const expectUrgentNaming = (...parts: (string | RegExp)[]) => {
  const hit = urgent().find(m => parts.every(p => (typeof p === "string" ? m.includes(p) : p.test(m))))
  expect(hit, `no URGENT alert names ${parts.join(", ")}; got: ${JSON.stringify(urgent())}`).toBeTruthy()
  // Urgent alerts keep the email fallback (4th argument false).
  const call = h.notifyAdmins.mock.calls.find(c => c[0] === hit)!
  expect(call[3]).toBe(false)
}

function expectHeld(row: Row, reference: string, reason: RegExp) {
  expect(row).toMatchObject({ payment_status: "paid", payment_reference: reference, status: "failed", hubtel_client_reference: null })
  expect(row.paid_at).toBeTruthy()
  expect(String(row.failure_reason)).toMatch(new RegExp(`^${BOT_NEEDS_REVIEW_PREFIX}`))
  expect(String(row.failure_reason)).toMatch(reason)
}

beforeEach(() => { h.notifyAdmins.mockClear(); h.notifyAdmins.mockImplementation(async () => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe("one Hubtel payment for a Special group", () => {
  it("amount equals the sum (pesewa-exact): every child flipped with the one reference, one share each, no dispatch until the deferred task, then each once in order", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const handlers = createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer })
    const store = txStore(tables)

    expect(await processFulfillment(store, handlers, paidInfo())).toBe("fulfilled")
    expect(tables.hubtel_transactions[0]).toMatchObject({ state: "fulfilled", callback_status: "pending" })

    // Each confirmation carries the child's own price, never the total.
    expect(vi.mocked(r.confirmQueued).mock.calls.map(c => [c[1], c[2]])).toEqual([
      ["c1", { paidAmount: 5.07, reference: "H1" }], ["c2", { paidAmount: 5.07, reference: "H1" }], ["c3", { paidAmount: 5.07, reference: "H1" }],
    ])
    for (const c of tables[TABLE]) expect(c).toMatchObject({ payment_status: "paid", payment_reference: "H1", status: "pending" })
    expect(r.profits.map(p => [p.data_order_id, p.shop_id, p.profit_amount])).toEqual([["c1", "shop1", 0.15], ["c2", "shop1", 0.15], ["c3", "shop1", 0.15]])

    // The handler has returned; nothing was sent yet.
    expect(r.posts).toEqual([])
    expect(r.dispatchGroup).not.toHaveBeenCalled()
    expect(r.defer).toHaveBeenCalledTimes(1)

    await r.runDeferred()
    expect(r.posts).toEqual(["c1", "c2", "c3"])
    expect(vi.mocked(r.dispatchGroup).mock.calls[0].slice(0, 3)).toEqual([GROUP, ["c1", "c2", "c3"], 3])
    for (const c of tables[TABLE]) expect(c.status).toBe("processing")
    expect(urgent()).toEqual([])
    expect(r.engineAlerts).toEqual([])

    // A duplicate callback never reaches the handler.
    expect(await processFulfillment(store, handlers, paidInfo())).toBe("duplicate")
    expect(r.confirmQueued).toHaveBeenCalledTimes(3)
  })

  it("the sum is compared in integer pesewas, also with numeric strings (0.07 x 3 is not exact in floats)", async () => {
    const tables: Record<string, Row[]> = {
      [TABLE]: group(3, () => ({ paid_amount: "0.07", shop_id: null, shop_share_amount: 0 })),
      hubtel_transactions: [paidTx({ amount_after_charges: 0.21 })],
    }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    await createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")
    expect(r.profits).toEqual([])
    expect(r.confirmQueued).toHaveBeenCalledTimes(3)
    await r.runDeferred()
    expect(r.posts).toEqual(["c1", "c2", "c3"])
  })

  for (const [label, amount] of [["over", 15.22], ["short", 15.2]] as const) {
    it(`Hubtel amount 1 pesewa ${label}: nothing flipped by the engine, nothing dispatched, every unpaid child recorded, throws, URGENT`, async () => {
      const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx({ amount_after_charges: amount })] }
      const { client } = fakeDb(tables)
      const r = rig(tables)
      const h7 = createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders
      await expect(h7("c1")).rejects.toThrow(/does not match/)
      expect(r.confirmQueued).not.toHaveBeenCalled()
      expect(r.defer).not.toHaveBeenCalled()
      expect(r.dispatchGroup).not.toHaveBeenCalled()
      expect(r.profits).toEqual([])
      for (const c of tables[TABLE]) expectHeld(c, "H1", /does not match/)
      expectUrgentNaming(GROUP, /held/i, "Nothing was sent for this payment")
    })
  }

  it("a held group's handler re-run: its failed children are not a retry, so it holds again and the row can never land fulfilled", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const handlers = createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer })
    await expect(processFulfillment(txStore(tables), handlers, paidInfo({ amountAfterCharges: 15.22 }))).resolves.toBe("needs_review")
    // Every child is now paid with this reference + failed, and the facts now match the sum.
    tables.hubtel_transactions[0].amount_after_charges = 15.21
    const held = tables[TABLE].map(c => ({ ...c }))
    await expect(handlers.hubtel_data_orders("c1")).rejects.toThrow(/unit 1\/3 is failed\/paid/)
    expect(r.confirmQueued).not.toHaveBeenCalled()
    expect(r.defer).not.toHaveBeenCalled()
    expect(tables[TABLE]).toEqual(held)
  })

  it("processFulfillment end to end: the over-payment lands the tx row in needs_review with the reason", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }), paidInfo({ amountAfterCharges: 15.22 }))
    expect(out).toBe("needs_review")
    expect(tables.hubtel_transactions[0].review_reason).toMatch(/does not match/)
    expect(tables.hubtel_transactions[0].callback_status).toBe("pending")
    for (const c of tables[TABLE]) expectHeld(c, "H1", /does not match/)
  })

  const holds: Array<[string, () => Row[], Partial<HubtelTxRow>, RegExp]> = [
    ["one child failed before payment", () => group(3, i => (i === 2 ? { status: "failed", failure_reason: "x" } : {})), {}, /unit 2\/3/],
    ["one child already completed", () => group(3, i => (i === 3 ? { status: "completed", payment_status: "paid", payment_reference: "H1-other" } : {})), {}, /unit 3\/3/],
    ["one child paid under another reference", () => group(3, i => (i === 2 ? { payment_status: "paid", payment_reference: "OTHER" } : {})), {}, /unit 2\/3/],
    ["one child paid with this reference but failed", () => group(3, i => (i === 2 ? { payment_status: "paid", payment_reference: "H1", status: "failed" } : {})), {}, /unit 2\/3/],
    ["one child with no paid_amount", () => group(3, i => (i === 2 ? { paid_amount: null } : i === 1 ? { paid_amount: 10.14 } : {})), {}, /paid_amount/],
    ["one child with a zero paid_amount", () => group(3, i => (i === 2 ? { paid_amount: 0 } : i === 1 ? { paid_amount: 10.14 } : {})), {}, /paid_amount/],
    ["one child with a negative paid_amount", () => group(3, i => (i === 2 ? { paid_amount: -5.07 } : i === 1 ? { paid_amount: 15.21 } : {})), {}, /paid_amount/],
    ["no Hubtel amount recorded", () => group(), { amount_after_charges: null }, /no Hubtel amount/],
    ["a child of another channel", () => group(3, i => (i === 2 ? { channel: "dashboard" } : {})), {}, /unit 2\/3/],
  ]
  for (const [name, mk, tx, reason] of holds) {
    it(`held as one: ${name}`, async () => {
      const tables: Record<string, Row[]> = { [TABLE]: mk(), hubtel_transactions: [paidTx(tx)] }
      const before = tables[TABLE].map(c => ({ ...c }))
      const { client } = fakeDb(tables)
      const r = rig(tables)
      const h7 = createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders
      await expect(h7("c1")).rejects.toThrow(reason)
      expect(r.confirmQueued).not.toHaveBeenCalled()
      expect(r.defer).not.toHaveBeenCalled()
      expect(r.posts).toEqual([])
      expect(r.profits).toEqual([])
      // Every child still unpaid (in the bots channel) is recorded; one already paid keeps its own record.
      tables[TABLE].forEach((c, k) => {
        if (before[k].payment_status === "unpaid" && before[k].channel === "bots") expectHeld(c, "H1", reason)
        else expect(c).toEqual(before[k])
      })
      expectUrgentNaming(GROUP)
    })
  }

  it("a group with no children is held; the recorder is told the row the transaction points at", async () => {
    const record = vi.fn(async () => 0)
    await expect(specialGroupPostPayment({} as any, { groupId: GROUP, children: [] },
      { orderId: "c1", reference: "H1", amountAfterCharges: 15.21 },
      { confirmQueued: vi.fn(), dispatchGroup: vi.fn(), defer: vi.fn(), record, startedAt: NOW })).rejects.toThrow(/no units/)
    expect(record).toHaveBeenCalledWith({}, TABLE, "c1", expect.objectContaining({ reference: "H1" }))
    expectUrgentNaming(GROUP)
  })

  it("the hold still throws and alerts when recording it fails", async () => {
    const record = vi.fn(async () => { throw new Error("db down") })
    const dispatchGroup = vi.fn()
    const children = group().map(c => ({ ...c, paid_amount: 1 })) as any
    await expect(specialGroupPostPayment({} as any, { groupId: GROUP, children },
      { orderId: "c1", reference: "H1", amountAfterCharges: 15.21 },
      { confirmQueued: vi.fn(), dispatchGroup, defer: vi.fn(), record, startedAt: NOW })).rejects.toThrow(/does not match/)
    expect(dispatchGroup).not.toHaveBeenCalled()
    expectUrgentNaming(GROUP)
  })

  it("the group cannot be read in the handler: held, URGENT, nothing confirmed", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables, { read: cols => cols.includes("special_index") })
    const r = rig(tables)
    await expect(createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")).rejects.toThrow(/could not be read/)
    expect(r.confirmQueued).not.toHaveBeenCalled()
    expect(r.defer).not.toHaveBeenCalled()
    expectHeld(tables[TABLE][0], "H1", /could not be read/)
    expect(urgent().length).toBeGreaterThan(0)
  })

  it("the payment facts cannot be read back: throws, URGENT names the group, nothing confirmed", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables, { read: cols => cols.startsWith("session_id") })
    const r = rig(tables)
    await expect(createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")).rejects.toThrow(/hubtel_transactions read failed/)
    expect(r.confirmQueued).not.toHaveBeenCalled()
    expectUrgentNaming(GROUP)
  })

  // Defensive only: processFulfillment never re-runs a handler for a claimed row. A real death is handled by the sweep (see below).
  it("handler called again directly after everything flipped and sent: no second share, no second dispatch, no alert, no needs_review", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const h7 = createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders
    await h7("c1")
    await r.runDeferred()
    expect(r.posts).toEqual(["c1", "c2", "c3"])

    await expect(h7("c1")).resolves.toBeUndefined()
    expect(r.defer).toHaveBeenCalledTimes(1)
    expect(r.dispatchGroup).toHaveBeenCalledTimes(1)
    expect(r.profits).toHaveLength(3)
    expect(r.posts).toEqual(["c1", "c2", "c3"])
    expect(urgent()).toEqual([])
    expect(r.engineAlerts).toEqual([])
  })

  // Engine-level guard, NOT a production resume path: nothing re-runs this handler after a death. See the sweep tests below.
  it("handler called directly on a partly flipped group: only children the engine resumes or flips are dispatched; no second share", async () => {
    const tables: Record<string, Row[]> = {
      [TABLE]: [
        child(1, { payment_status: "paid", payment_reference: "H1", status: "processing", hubtel_client_reference: "HCS-c1" }),
        child(2, { payment_status: "paid", payment_reference: "H1" }), // flipped and credited, never sent
        child(3, { payment_status: "paid", payment_reference: "H1" }), // flipped, died before the share
        child(4), // never reached
      ],
      hubtel_transactions: [paidTx({ amount_after_charges: 20.28 })],
    }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    r.profits.push({ data_order_id: "c1", shop_id: "shop1", profit_amount: 0.15 }, { data_order_id: "c2", shop_id: "shop1", profit_amount: 0.15 })
    await createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")
    await r.runDeferred()
    expect(r.posts).toEqual(["c2", "c3", "c4"])
    expect(vi.mocked(r.dispatchGroup).mock.calls[0].slice(0, 3)).toEqual([GROUP, ["c2", "c3", "c4"], 4])
    expect(r.profits.map(p => p.data_order_id)).toEqual(["c1", "c2", "c3", "c4"])
    expect(urgent()).toEqual([])
  })

  for (const outcome of ["error", "refused", "amount_mismatch"] as const) {
    it(`confirm returns '${outcome}' on child 3: the rest are flipped and sent, the handler throws, URGENT names the group and the unit`, async () => {
      const tables: Record<string, Row[]> = { [TABLE]: group(4), hubtel_transactions: [txRow({ expected_amount: 20.28 })] }
      const { client } = fakeDb(tables)
      const r = rig(tables)
      const realConfirm = r.confirmQueued
      const confirmQueued: ConfirmQueuedFn = async (t, id, p, q) => (id === "c3" ? { outcome } : realConfirm(t, id, p, q))
      const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }), paidInfo({ amountAfterCharges: 20.28 }))
      expect(out).toBe("needs_review")
      expect(tables.hubtel_transactions[0].review_reason).toMatch(new RegExp(`${GROUP}.*3/4`))
      expect(r.profits.map(p => p.data_order_id)).toEqual(["c1", "c2", "c4"])
      expect(r.defer).toHaveBeenCalledTimes(1)
      await r.runDeferred()
      expect(r.posts).toEqual(["c1", "c2", "c4"])
      expectUrgentNaming(GROUP, "3/4", outcome)
      // The failed child's money is visible: paid + failed + needs review, refundable, never sent.
      expectHeld(tables[TABLE][2], "H1", /3\/4/)
      // The others are not touched by that record.
      for (const k of [0, 1, 3]) expect(tables[TABLE][k]).toMatchObject({ status: "processing", failure_reason: null })
    })
  }

  it("confirm THROWS on child 2: treated as an error for that child, the rest continue", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const realConfirm = r.confirmQueued
    const confirmQueued: ConfirmQueuedFn = async (t, id, p, q) => { if (id === "c2") throw new Error("boom"); return realConfirm(t, id, p, q) }
    await expect(createOrderHandlers(client, { confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")).rejects.toThrow(/2\/3/)
    await r.runDeferred()
    expect(r.posts).toEqual(["c1", "c3"])
    expectUrgentNaming(GROUP, "2/3")
  })

  it("the flip committed but the caller saw 'error': the review record is a no-op for that child, its share stands, it is named", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const realConfirm = r.confirmQueued
    const confirmQueued: ConfirmQueuedFn = async (t, id, p, q) => {
      if (id !== "c2") return realConfirm(t, id, p, q)
      await realConfirm(t, id, p, [])
      return { outcome: "error" }
    }
    await expect(createOrderHandlers(client, { confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")).rejects.toThrow(/2\/3/)
    expect(tables[TABLE][1]).toMatchObject({ payment_status: "paid", status: "pending", failure_reason: null })
    expect(r.profits).toHaveLength(3)
    expectUrgentNaming(GROUP, "2/3")
  })

  it("a child failed between the read and the flip (engine: confirmed, status failed): named too, so the row lands in needs_review", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const realConfirm = r.confirmQueued
    const confirmQueued: ConfirmQueuedFn = async (t, id, p, q) => {
      if (id === "c2") tables[TABLE][1].status = "failed"
      return realConfirm(t, id, p, q)
    }
    await expect(createOrderHandlers(client, { confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")).rejects.toThrow(/2\/3/)
    await r.runDeferred()
    expect(r.posts).toEqual(["c1", "c3"])
    expect(r.profits.map(p => p.data_order_id)).toEqual(["c1", "c3"])
    expectUrgentNaming(GROUP, "2/3")
  })

  it("defer missing: dispatch runs inline before the handler returns", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    await createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup }).hubtel_data_orders("c1")
    expect(r.posts).toEqual(["c1", "c2", "c3"])
  })

  it("defer throws: the payment is taken, so dispatch runs inline, once", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const defer = () => { throw new Error("after() unavailable") }
    await createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer }).hubtel_data_orders("c1")
    expect(r.posts).toEqual(["c1", "c2", "c3"])
    expect(r.dispatchGroup).toHaveBeenCalledTimes(1)
  })

  it("the deferred dispatch fails outright: never swallowed, URGENT names the group", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const dispatchGroup = vi.fn(async () => { throw new Error("runtime unavailable") })
    await createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")
    await expect(r.runDeferred()).resolves.toBeUndefined()
    expectUrgentNaming(GROUP, /PAID/)
  })

  it("an inline dispatch that fails outright is alerted too and does not turn a paid group into a thrown handler", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const dispatchGroup = vi.fn(async () => { throw new Error("runtime unavailable") })
    await expect(createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup }).hubtel_data_orders("c1")).resolves.toBeUndefined()
    expectUrgentNaming(GROUP, /PAID/)
  })

  it("the time budget runs from when the request built its handlers, so a late handler in a long cron run cannot overrun maxDuration", async () => {
    vi.useFakeTimers({ now: NOW })
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [paidTx()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const handlers = createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer })
    vi.setSystemTime(NOW + 100_000)
    await handlers.hubtel_data_orders("c1")
    await r.runDeferred()
    expect(vi.mocked(r.dispatchGroup).mock.calls[0][3]).toBe(NOW)
  })

  it("a non-group row with no special_group_id never takes the group path", async () => {
    const tables: Record<string, Row[]> = {
      [TABLE]: [child(1, { special_group_id: null, special_index: null, paid_amount: 15.21 })],
      hubtel_transactions: [paidTx()],
    }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const confirmBot: ConfirmBotFn = vi.fn(async () => ({ outcome: "confirmed" as const }))
    await createOrderHandlers(client, { confirmBot, confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }).hubtel_data_orders("c1")
    expect(confirmBot).toHaveBeenCalledWith(TABLE, "c1", { paidAmount: 15.21, reference: "H1" })
    expect(r.confirmQueued).not.toHaveBeenCalled()
    expect(r.defer).not.toHaveBeenCalled()
  })
})

describe("the process died mid-handler: the sweep in runStatusChecks", () => {
  const stale = (o: Partial<HubtelTxRow> = {}) => paidTx({ state: "processing", ...o })
  const sweep = (tables: Record<string, Row[]>, client: any, paidReviewHandlers?: any) => {
    const r = rig(tables)
    return runStatusChecks({
      store: txStore(tables), handlers: createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }),
      failHandlers: createFailHandlers(client), paidReviewHandlers: paidReviewHandlers ?? createPaidReviewHandlers(client),
      possiblyPaidAlerts: createPossiblyPaidAlerts(client), now: NOW,
      check: async () => ({ ok: true, status: "Unpaid" }),
    }).then(res => ({ res, r }))
  }

  it("the alert says a held unit is refunded there or delivered by hand, never 'refund or deliver' from the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale()] }
    await sweep(tables, fakeDb(tables).client)
    expectUrgentNaming(GROUP, "Admin > Refunds", "refund them there, or deliver by hand")
    expect(urgent().join()).not.toMatch(/refund or deliver/)
  })

  describe("a row with no paid_at (no proof of payment: it may also be a crash in the expiry path)", () => {
    it("a Special group: URGENT 'possibly paid: check with Hubtel', naming group and session; still nothing recorded", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale({ paid_at: null, hubtel_order_id: null })] }
      const { res } = await sweep(tables, fakeDb(tables).client)
      expect(res.swept).toBe(1)
      expectUrgentNaming(GROUP, "S1", /possibly paid/i, /check with Hubtel/i)
      for (const c of tables[TABLE]) expect(c).toMatchObject({ payment_status: "unpaid", status: "pending", payment_reference: null })
    })

    it("a non-group row: no alert, same behaviour as before", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const tables: Record<string, Row[]> = {
        [TABLE]: [child(1, { special_group_id: null, special_index: null })],
        hubtel_transactions: [stale({ paid_at: null })],
      }
      const { res } = await sweep(tables, fakeDb(tables).client)
      expect(res.swept).toBe(1)
      expect(urgent()).toEqual([])
      expect(tables[TABLE][0]).toMatchObject({ payment_status: "unpaid", status: "pending" })
    })

    it("a row WITH paid_at gets the handler-died alert only, not 'possibly paid'", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale()] }
      await sweep(tables, fakeDb(tables).client)
      expect(urgent().join()).not.toMatch(/possibly paid/i)
    })

    it("a failed notifyAdmins is logged and the sweep moves on", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      h.notifyAdmins.mockImplementation(async () => { throw new Error("sms down") })
      const tables: Record<string, Row[]> = {
        [TABLE]: [child(1), child(9, { special_group_id: "g-2", special_index: 1 })],
        hubtel_transactions: [stale({ paid_at: null }), stale({ session_id: "S2", order_id: "c9", paid_at: null })],
      }
      const { res } = await sweep(tables, fakeDb(tables).client)
      expect(res.swept).toBe(2)
      expect(log.mock.calls.some(c => c.some(x => String(x).includes("urgent alert failed")))).toBe(true)
    })

    it("an alerter that throws is logged and the sweep moves on", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      const tables: Record<string, Row[]> = {
        [TABLE]: [child(1)],
        hubtel_transactions: [stale({ paid_at: null }), stale({ session_id: "S2", order_id: "c1", paid_at: null })],
      }
      const r = rig(tables)
      const { client } = fakeDb(tables)
      const res = await runStatusChecks({
        store: txStore(tables), handlers: createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }),
        failHandlers: createFailHandlers(client), paidReviewHandlers: createPaidReviewHandlers(client),
        possiblyPaidAlerts: { [TABLE]: async () => { throw new Error("boom") } }, now: NOW,
        check: async () => ({ ok: true, status: "Unpaid" }),
      })
      expect(res.swept).toBe(2)
      expect(log.mock.calls.some(c => String(c[0]).includes("possibly paid") && c.includes("S1"))).toBe(true)
    })

    it("the group read failing: we cannot tell, so URGENT names the order rather than staying silent", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale({ paid_at: null })] }
      const { res } = await sweep(tables, fakeDb(tables, { read: cols => cols === "special_group_id" }).client)
      expect(res.swept).toBe(1)
      expectUrgentNaming("c1", "S1", /possibly paid/i)
    })

    it("the cron route wires the alerts in", () => {
      const src = readFileSync(path.join(process.cwd(), "app/api/cron/hubtel-status-check/route.ts"), "utf8")
      expect(src).toMatch(/possiblyPaidAlerts:\s*createPossiblyPaidAlerts\(supabase\)/)
    })
  })

  it("death before child 1 flipped: every unit becomes paid + failed and refundable, URGENT names the group", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale()] }
    const { client } = fakeDb(tables)
    const { res, r } = await sweep(tables, client)
    expect(res.swept).toBe(1)
    expect(tables.hubtel_transactions[0]).toMatchObject({ state: "needs_review", callback_status: "pending" })
    for (const c of tables[TABLE]) expectHeld(c, "H1", /handler did not finish/)
    expect(r.confirmQueued).not.toHaveBeenCalled()
    expect(r.posts).toEqual([])
    expectUrgentNaming(GROUP, "3 of 3")
  })

  it("death after child 2 of 4: flipped units stay for the watch and the admin send; never-flipped units are held", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = {
      [TABLE]: [
        child(1, { payment_status: "paid", payment_reference: "H1", updated_at: new Date(NOW - 15 * 60_000).toISOString() }),
        child(2, { payment_status: "paid", payment_reference: "H1", updated_at: new Date(NOW - 15 * 60_000).toISOString() }),
        child(3),
        child(4),
      ],
      hubtel_transactions: [stale({ amount_after_charges: 20.28 })],
    }
    const { client } = fakeDb(tables)
    const { res, r } = await sweep(tables, client)
    expect(res.swept).toBe(1)
    for (const k of [0, 1]) {
      expect(tables[TABLE][k]).toMatchObject({ payment_status: "paid", status: "pending", failure_reason: null })
      expect(bundleCanDispatch(tables[TABLE][k] as any, 0, NOW)).toBe(true)
    }
    for (const k of [2, 3]) expectHeld(tables[TABLE][k], "H1", /handler did not finish/)
    expect(r.posts).toEqual([])
    expect(r.profits).toEqual([])
    expectUrgentNaming(GROUP, "2 of 4")
  })

  it("no Hubtel OrderId on the row: recorded under the session reference the handler would have used", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale({ hubtel_order_id: null })] }
    const { client } = fakeDb(tables)
    await sweep(tables, client)
    for (const c of tables[TABLE]) expectHeld(c, "hubtel-session:S1", /handler did not finish/)
  })

  it("a row with no paid_at holds no proof of payment: nothing is recorded on the order", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale({ paid_at: null })] }
    const { client } = fakeDb(tables)
    const { res } = await sweep(tables, client)
    expect(res.swept).toBe(1)
    for (const c of tables[TABLE]) expect(c).toMatchObject({ payment_status: "unpaid", status: "pending" })
  })

  it("a recorder failure is logged and does not stop the sweep of other rows", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = {
      [TABLE]: [child(1), child(9, { special_group_id: "g-2", special_index: 1 })],
      hubtel_transactions: [stale({ session_id: "S1", order_id: "c1", amount_after_charges: 5.07 }), stale({ session_id: "S2", order_id: "c9", hubtel_order_id: "H2", amount_after_charges: 5.07 })],
    }
    const { client } = fakeDb(tables)
    const real = createPaidReviewHandlers(client)
    const handlers = { hubtel_data_orders: async (id: string, p: any) => { if (id === "c1") throw new Error("db down"); return real.hubtel_data_orders(id, p) } }
    const { res } = await sweep(tables, client, handlers)
    expect(res.swept).toBe(2)
    expect(tables.hubtel_transactions.map(t => t.state)).toEqual(["needs_review", "needs_review"])
    expectHeld(tables[TABLE][1], "H2", /handler did not finish/)
    expect(log.mock.calls.some(c => String(c[0]).includes("could not record the held payment") && c.includes("S1"))).toBe(true)
  })

  it("an alert failure is logged and does not stop the sweep", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    h.notifyAdmins.mockImplementation(async () => { throw new Error("sms down") })
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [stale()] }
    const { client } = fakeDb(tables)
    const { res } = await sweep(tables, client)
    expect(res.swept).toBe(1)
    for (const c of tables[TABLE]) expectHeld(c, "H1", /handler did not finish/)
    expect(log.mock.calls.some(c => c.some(x => String(x).includes("urgent alert failed")))).toBe(true)
  })

  it("a single bot order gets the same paid + failed state its recorder always produces, with no group alert; an order already flipped is untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = {
      [TABLE]: [
        child(1, { special_group_id: null, special_index: null }),
        child(2, { special_group_id: null, special_index: null, payment_status: "paid", payment_reference: "H2" }),
      ],
      hubtel_transactions: [stale({ order_id: "c1" }), stale({ session_id: "S2", order_id: "c2", hubtel_order_id: "H2" })],
    }
    const { client } = fakeDb(tables)
    await sweep(tables, client)
    expectHeld(tables[TABLE][0], "H1", /handler did not finish/)
    expect(tables[TABLE][1]).toMatchObject({ payment_status: "paid", status: "pending", failure_reason: null })
    expect(urgent()).toEqual([])
  })

  it("a table with no paid-review recorder only moves the tx row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = {
      ussd_orders: [{ id: "u1", payment_status: "pending" }],
      hubtel_transactions: [stale({ order_table: "ussd_orders", order_id: "u1" })],
    }
    const { client } = fakeDb(tables)
    const { res } = await sweep(tables, client)
    expect(res.swept).toBe(1)
    expect(tables.ussd_orders[0].payment_status).toBe("pending")
  })
})

describe("dispatchSpecialGroup", () => {
  const setup = (rows: Row[], at = NOW) => {
    const tables: Record<string, Row[]> = { [TABLE]: rows }
    const r = rig(tables)
    ;(r.bundles as any).now = () => at
    return r
  }
  const paid = (i: number) => child(i, { payment_status: "paid", payment_reference: "H1" })

  it("sends in the given order and names units by the group's size, not the queue's", async () => {
    const r = setup([paid(2), paid(3)])
    ;(r.bundles as any).purchase = async (input: { orderId: string }) => {
      r.posts.push(input.orderId)
      return { state: input.orderId === "c3" ? "failed" : "pending", client_reference: "HCS" }
    }
    await dispatchSpecialGroup(r.bundles, GROUP, ["c2", "c3"], 5, NOW)
    expect(r.posts).toEqual(["c2", "c3"])
    expect(r.dispatchAlerts).toEqual([expect.stringContaining("unit 3/5")])
  })

  it("past the budget from startedAt it stops and alerts k of the group's size", async () => {
    const r = setup([paid(4), paid(5)], NOW + 240_001)
    await dispatchSpecialGroup(r.bundles, GROUP, ["c4", "c5"], 5, NOW)
    expect(r.posts).toEqual([])
    expect(r.dispatchAlerts).toEqual([expect.stringMatching(new RegExp(`Special group ${GROUP}: 2 of 5 units not sent \\(time budget\\)`))])
  })
})

describe("recordBotPaymentForReview on a Special group", () => {
  it("on child 1 covers every child still unpaid; a paid child and another channel's child are not touched; a second call is a no-op", async () => {
    const tables: Record<string, Row[]> = {
      [TABLE]: [
        child(1),
        child(2, { payment_status: "paid", payment_reference: "OTHER", status: "processing" }),
        child(3, { status: "failed", failure_reason: "Payment not completed" }),
        child(4, { channel: "dashboard" }),
        child(5, { special_group_id: "another-group" }),
      ],
    }
    const { client } = fakeDb(tables)
    expect(await recordBotPaymentForReview(client, TABLE, "c1", { reference: "HL", reason: "late" })).toBe(2)
    expectHeld(tables[TABLE][0], "HL", /late\. Not sent/)
    expectHeld(tables[TABLE][2], "HL", /late\. Not sent/)
    expect(tables[TABLE][1]).toMatchObject({ payment_reference: "OTHER", status: "processing", failure_reason: null })
    expect(tables[TABLE][3]).toMatchObject({ payment_status: "unpaid", status: "pending" })
    expect(tables[TABLE][4]).toMatchObject({ payment_status: "unpaid", status: "pending" })
    expect(await recordBotPaymentForReview(client, TABLE, "c1", { reference: "HL2", reason: "again" })).toBe(0)
    expect(tables[TABLE][0].payment_reference).toBe("HL")
  })

  it("a group read error is not hidden: logged, child 1 recorded by id, URGENT", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = { [TABLE]: group() }
    const { client } = fakeDb(tables, { read: cols => cols === "special_group_id" })
    expect(await recordBotPaymentForReview(client, TABLE, "c1", { reference: "HL", reason: "late" })).toBe(1)
    expectHeld(tables[TABLE][0], "HL", /late/)
    expect(tables[TABLE][1].payment_status).toBe("unpaid")
    expect(log).toHaveBeenCalled()
    expectUrgentNaming("c1", /Special group/)
  })

  it("a failed group update raises and alerts URGENT", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = { [TABLE]: group() }
    const { client } = fakeDb(tables, { update: on => on.includes("special_group_id") })
    await expect(recordBotPaymentForReview(client, TABLE, "c1", { reference: "HL", reason: "late" })).rejects.toBeTruthy()
    expectUrgentNaming(GROUP)
  })

  it("late success on a group failed by expiry: held for the whole group, nothing confirmed or sent", async () => {
    const tables: Record<string, Row[]> = {
      [TABLE]: group(),
      hubtel_transactions: [txRow({ created_at: new Date(NOW - 2 * 60 * 60_000).toISOString() })],
    }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const store = txStore(tables)
    const handlers = createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer })
    const paidReviewHandlers = createPaidReviewHandlers(client)
    await runStatusChecks({ store, handlers, failHandlers: createFailHandlers(client), paidReviewHandlers, now: NOW, check: async () => ({ ok: true, status: "Unpaid" }) })
    for (const c of tables[TABLE]) expect(c).toMatchObject({ status: "failed", payment_status: "unpaid" })

    expect(await processFulfillment(store, handlers, paidInfo({ hubtelOrderId: "HLATE" }), { paidReview: paidReviewHandlers })).toBe("needs_review")
    expect(r.confirmQueued).not.toHaveBeenCalled()
    expect(r.defer).not.toHaveBeenCalled()
    for (const c of tables[TABLE]) expectHeld(c, "HLATE", /arrived late/)
    expectUrgentNaming(GROUP, "HLATE", /arrived late/, "3 of 3 units are held for a real payment", /refunding or delivering by hand/)
    expect(urgent().join()).not.toMatch(/handler died/)
  })

  it("late success on a single bot order: the recorder works as before, no group alert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = {
      [TABLE]: [child(1, { special_group_id: null, special_index: null, status: "failed" })],
      hubtel_transactions: [txRow({ state: "failed" })],
    }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }),
      paidInfo({ hubtelOrderId: "HLATE", amountAfterCharges: 5.07 }), { paidReview: createPaidReviewHandlers(client) })
    expect(out).toBe("needs_review")
    expectHeld(tables[TABLE][0], "HLATE", /arrived late/)
    expect(urgent()).toEqual([])
  })

  it("underpayment on a group: held for the whole group through the same recorder", async () => {
    const tables: Record<string, Row[]> = { [TABLE]: group(), hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const r = rig(tables)
    const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmQueued: r.confirmQueued, dispatchGroup: r.dispatchGroup, defer: r.defer }),
      paidInfo({ amountAfterCharges: 10 }), { paidReview: createPaidReviewHandlers(client) })
    expect(out).toBe("needs_review")
    expect(r.confirmQueued).not.toHaveBeenCalled()
    for (const c of tables[TABLE]) expectHeld(c, "H1", /short/)
    expectUrgentNaming(GROUP, "H1", /short/, "after_charges 10", "3 of 3 units are held for a real payment", /refunding or delivering by hand/)
    expect(urgent().join()).not.toMatch(/handler died/)
  })

  it("a late or short payment on a group whose recording fails has its own alert only, then raises (held wording not sent)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const tables: Record<string, Row[]> = { [TABLE]: group() }
    const { client } = fakeDb(tables, { update: on => on.includes("special_group_id") })
    await expect(recordBotPaymentForReview(client, TABLE, "c1", { reference: "HL", reason: "late", held: true })).rejects.toBeTruthy()
    expect(urgent()).toHaveLength(1)
    expect(urgent()[0]).not.toMatch(/held for a real payment/)
  })
})

describe("what admins are told to do with a unit that was not sent", () => {
  const opts = (over: Partial<Parameters<typeof specialGroupPostPayment>[3]> = {}) => ({
    confirmQueued: vi.fn(async (): Promise<ConfirmResult> => ({ outcome: "error" })) as unknown as ConfirmQueuedFn,
    dispatchGroup: vi.fn(async () => {}), record: vi.fn(async () => 0), startedAt: NOW, ...over,
  })
  const asGroup = () => ({ groupId: GROUP, children: group() as any[] })

  it("a held payment: refund it there, or deliver by hand", async () => {
    await expect(specialGroupPostPayment({} as any, asGroup(), { orderId: "c1", reference: "H1", amountAfterCharges: 1 }, opts())).rejects.toBeTruthy()
    expectUrgentNaming(GROUP, "Admin > Refunds", "refund it there, or deliver by hand")
    expect(urgent().join()).not.toMatch(/refund or deliver/)
  })

  it("units that could not be confirmed: refund them there, or deliver by hand", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(specialGroupPostPayment({} as any, asGroup(), { orderId: "c1", reference: "H1", amountAfterCharges: 15.21 }, opts())).rejects.toBeTruthy()
    expectUrgentNaming(GROUP, "Admin > Refunds", "refund them there, or deliver by hand")
    expect(urgent().join()).not.toMatch(/refund or deliver/)
  })
})

describe("stuck-children watch", () => {
  it("alerts for a channel='bots' group; the admin page it names can send a bot child", async () => {
    const stuck = child(1, { payment_status: "paid", payment_reference: "H1", updated_at: new Date(NOW - 10 * 60_000).toISOString() })
    expect(bundleCanDispatch(stuck as any, 0, NOW)).toBe(true)
    const eqs: Array<[string, unknown]> = []
    const orders = [{ special_group_id: GROUP }, { special_group_id: GROUP }]
    const chain = (rows: unknown): any => {
      const q: any = {
        select: () => q, not: () => q, is: () => q, lt: () => q, limit: () => q, in: () => q, or: () => q,
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return q },
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ error: null }),
        then: (res: any) => res({ data: rows, error: null }),
      }
      return q
    }
    const db: any = { from: (t: string) => chain(t === TABLE ? orders : []) }
    const sent: string[] = []
    const out = await watchStuckSpecialGroups(db, { alert: async m => { sent.push(m) }, now: () => NOW })
    expect(out.alerted).toBe(1)
    expect(sent).toEqual([specialStuckMessage(GROUP, 2)])
    expect(eqs.map(e => e[0])).not.toContain("channel") // no channel filter: bot groups are watched
  })
})

/** Records every call; each table answers its rows, filters ignored (as lib/refunds/bots.test.ts). */
function listDb(rows: Record<string, unknown[]>, calls: unknown[][] = []) {
  const make = (table: string) => {
    const q: any = {}
    for (const m of ["select", "eq", "in", "is", "neq", "not", "gte", "lte", "order", "range", "limit", "or"]) {
      q[m] = (...a: unknown[]) => { calls.push([table, m, ...a]); return q }
    }
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length }).then(res, rej)
    return q
  }
  return { from: (t: string) => make(t), rpc: async () => ({ data: [], error: null }) } as any
}

describe("admin views of a Hubtel-paid Special child", () => {
  const paidChild = (i: number, o: Row = {}) =>
    child(i, { payment_status: "paid", payment_reference: "H1", updated_at: new Date(NOW - 10 * 60_000).toISOString(), ...o })
  const paidTxRow = { order_id: "c1", hubtel_order_id: "H1", amount_paid: 15.6, amount_after_charges: 15.21, paid_at: new Date(NOW).toISOString(), mobile: "233241234567" }

  it("appears in the admin Standard Bundles orders route with its Special badge and bot label", async () => {
    h.db = listDb({ [TABLE]: [paidChild(1), paidChild(2), paidChild(3)] })
    const { GET } = await import("@/app/api/admin/standard-bundles/orders/route")
    const res = await GET(new NextRequest("http://localhost/api/admin/standard-bundles/orders?channel=bots"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.map((r: Row) => r.id)).toEqual(["c1", "c2", "c3"])
    expect(body.rows[1]).toMatchObject({ channel: "bots", special_label: "Special 2/3", payment_status: "paid" })
    expect(body.rows[1].channel_label).toBeTruthy()
    expect(body.rows[1].purchaser).toBe("233241234567")
  })

  it("is listed on /admin/refunds (paid, bots, no account)", async () => {
    const calls: unknown[][] = []
    const db = listDb({ [TABLE]: [{ id: "c2", created_at: new Date(NOW).toISOString() }] }, calls)
    const refs = await listPendingOrderRefs(db, { table: TABLE, page: 1, pageSize: 20 } as any)
    expect(refs.map(r => r.id)).toContain("c2")
    expect(calls).toContainEqual([TABLE, "eq", "channel", "bots"])
    expect(calls).toContainEqual([TABLE, "is", "user_id", null])
  })

  it("every child refunds on its own, to the payer's phone, for its own price; the whole-transaction Hubtel refund is refused on child 1", async () => {
    vi.stubEnv("HUBTEL_REFUND_ENABLED", "true")
    const db = listDb({
      [TABLE]: [paidChild(1), paidChild(2, { beneficiary_phone: "233209999999" }), paidChild(3)],
      hubtel_transactions: [paidTxRow],
      shop_profits: ["c1", "c2", "c3"].map(id => ({ shop_id: "shop1", profit_amount: 0.15, status: "credited", data_order_id: id })),
      user_shops: [{ id: "shop1", shop_name: "Alpha", user_id: "u1" }],
    })
    const orders = await loadRefundableOrders(db, [{ table: TABLE, id: "c1" }, { table: TABLE, id: "c2" }, { table: TABLE, id: "c3" }])
    expect(orders.map(o => o.id)).toEqual(["c1", "c2", "c3"])
    for (const o of orders) {
      expect(o.paid).toBe(5.07) // never the total
      expect(o.payment.payerPhone).toBe("0241234567")
      expect(o.payment.reference).toBeNull() // no Paystack reversal
      expect(o.owners.map(x => [x.shopId, x.credited])).toEqual([["shop1", 0.15]]) // this child's own share
      expect(moolreGateway.supports(o)).toEqual({ ok: true })
      expect(orderEligibility(o, NOW)).toEqual({ eligible: true })
    }
    // Refunding the single Hubtel transaction would return the whole group's money for one unit.
    expect(orders[0].specialGroupId).toBe(GROUP)
    expect(hubtelGateway.supports(orders[0])).toMatchObject({ ok: false, reason: expect.stringContaining("Special Bundle") })
    expect(hubtelGateway.supports(orders[1]).ok).toBe(false)
  })

  it("the whole-transaction Hubtel refund is refused even when Hubtel's net happens to equal the child's price", async () => {
    vi.stubEnv("HUBTEL_REFUND_ENABLED", "true")
    const db = listDb({ [TABLE]: [paidChild(1)], hubtel_transactions: [{ ...paidTxRow, amount_paid: 5.3, amount_after_charges: 5.07 }] })
    const [o] = await loadRefundableOrders(db, [{ table: TABLE, id: "c1" }])
    expect(hubtelGateway.supports(o)).toMatchObject({ ok: false, reason: expect.stringContaining("Special Bundle") })
    const ungrouped = listDb({ [TABLE]: [paidChild(1, { special_group_id: null })], hubtel_transactions: [{ ...paidTxRow, amount_paid: 5.3, amount_after_charges: 5.07 }] })
    const [single] = await loadRefundableOrders(ungrouped, [{ table: TABLE, id: "c1" }])
    expect(single.specialGroupId).toBeUndefined()
    expect(hubtelGateway.supports(single)).toEqual({ ok: true })
  })

  it("a child with an active refund is refused a second one; its siblings stay refundable", async () => {
    const db = listDb({
      [TABLE]: [paidChild(2), paidChild(3)],
      order_refunds: [{ order_id: "c2", status: "pending" }],
    })
    const [c2, c3] = await loadRefundableOrders(db, [{ table: TABLE, id: "c2" }, { table: TABLE, id: "c3" }])
    expect(c2.evidence.hasActiveRefund).toBe(true)
    expect(orderEligibility(c2, NOW).eligible).toBe(false)
    expect(orderEligibility(c3, NOW)).toEqual({ eligible: true })
  })

  it("a bot Special row carries no account (0158), so the refund list's user_id filter holds", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../migrations/0158_bot_special_bundles.sql"), "utf8")
    expect(sql).toMatch(/reference_code, user_id, channel, bot_surface/)
    expect(sql).toMatch(/NULL, 'bots', p_surface/)
  })
})
