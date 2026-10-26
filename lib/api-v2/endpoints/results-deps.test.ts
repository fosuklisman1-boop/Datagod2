import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
const checkPhoneVerified = vi.hoisted(() => vi.fn())
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified }))
const purchaseResultsCheckerVouchers = vi.hoisted(() => vi.fn(async () => ({ order: {}, vouchers: [], newBalance: 1 })))
vi.mock("@/lib/results-checker-service", () => ({
  purchaseResultsCheckerVouchers,
  calculateRCPrice: vi.fn(),
  getAvailableCount: vi.fn(),
  getMaxQuantity: vi.fn(),
  isExamBoardEnabled: vi.fn(),
}))
const notifyAdmins = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins }))
const deliverVouchers = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/results-checker-notification-service", () => ({ deliverVouchers }))
vi.mock("../store", async (orig) => ({ ...(await orig<typeof import("../store")>()), getAdminClient: () => ({ fake: true }) }))

import {
  fetchOwnedVouchers,
  fetchResultsOrderByCode,
  realResultsAlert,
  realResultsDeliver,
  realResultsEngine,
  RESULTS_ORDER_COLUMNS,
  MAX_VOUCHER_IDS,
} from "./results-deps"

type Call = [string, ...unknown[]]

/** Table-aware fake: each table answers with its own result; every builder call is recorded. */
function fakeClient(tables: Record<string, { data: unknown; error?: unknown } | "throw">) {
  const calls: Call[] = []
  const client = {
    from: (t: string) => {
      calls.push(["from", t])
      const result = tables[t]
      const settle = () => (result === "throw" || result === undefined ? Promise.reject(new Error("db")) : Promise.resolve({ error: null, ...result }))
      const q: any = {}
      for (const m of ["select", "eq", "update"]) {
        q[m] = (...a: unknown[]) => {
          calls.push([`${t}.${m}`, ...a])
          return q
        }
      }
      q.in = (...a: unknown[]) => {
        calls.push([`${t}.in`, ...a])
        return q
      }
      q.order = (...a: unknown[]) => {
        calls.push([`${t}.order`, ...a])
        return q
      }
      q.maybeSingle = () => {
        calls.push([`${t}.maybeSingle`])
        return settle()
      }
      q.then = (res: any, rej: any) => settle().then(res, rej)
      return q
    },
  }
  return { client: client as any, calls }
}

const ORDER = { status: "completed", inventory_ids: ["inv-2", "inv-1"] }

describe("fetchOwnedVouchers: owner-scoped through the order", () => {
  it("selects the order by reference_code AND user_id first, then only pin + serial_number for ITS ids, ordered", async () => {
    const { client, calls } = fakeClient({
      results_checker_orders: { data: ORDER },
      results_checker_inventory: { data: [{ pin: "P1", serial_number: "S1", id: "leak" }, { pin: "P2", serial_number: null }] },
    })
    const v = await fetchOwnedVouchers(client, "user-1", "RC-AAA-BBB")
    expect(v).toEqual([{ pin: "P1", serial_number: "S1" }, { pin: "P2", serial_number: null }])
    expect(calls).toContainEqual(["results_checker_orders.eq", "user_id", "user-1"])
    expect(calls).toContainEqual(["results_checker_orders.eq", "reference_code", "RC-AAA-BBB"])
    expect(calls).toContainEqual(["results_checker_inventory.select", "pin, serial_number"])
    expect(calls).toContainEqual(["results_checker_inventory.in", "id", ["inv-2", "inv-1"]])
    expect(calls).toContainEqual(["results_checker_inventory.order", "id", { ascending: true }])
    // never selected by board or by anything but the order's ids
    expect(calls.some((c) => c[0] === "results_checker_inventory.eq")).toBe(false)
    const order = calls.findIndex((c) => c[0] === "results_checker_orders.maybeSingle")
    const inv = calls.findIndex((c) => c[0] === "results_checker_inventory.select")
    expect(order).toBeGreaterThanOrEqual(0)
    expect(order).toBeLessThan(inv)
  })

  it("a missing / foreign order never touches inventory", async () => {
    const { client, calls } = fakeClient({ results_checker_orders: { data: null }, results_checker_inventory: { data: [{ pin: "X", serial_number: "Y" }] } })
    expect(await fetchOwnedVouchers(client, "user-1", "RC-OTHER")).toBeNull()
    expect(calls.some((c) => String(c[0]).startsWith("results_checker_inventory"))).toBe(false)
  })

  it("fails closed: non-completed order, no/invalid/too many ids, short result, errors, throws", async () => {
    const inv = { data: [{ pin: "P", serial_number: "S" }] }
    const cases: Array<Record<string, any>> = [
      { results_checker_orders: { data: { ...ORDER, status: "failed" } }, results_checker_inventory: inv },
      { results_checker_orders: { data: { ...ORDER, status: "refunded" } }, results_checker_inventory: inv },
      { results_checker_orders: { data: { ...ORDER, inventory_ids: [] } }, results_checker_inventory: inv },
      { results_checker_orders: { data: { ...ORDER, inventory_ids: null } }, results_checker_inventory: inv },
      { results_checker_orders: { data: { ...ORDER, inventory_ids: [1, 2] } }, results_checker_inventory: inv },
      { results_checker_orders: { data: { ...ORDER, inventory_ids: Array.from({ length: MAX_VOUCHER_IDS + 1 }, (_, i) => `i${i}`) } }, results_checker_inventory: inv },
      { results_checker_orders: { data: ORDER }, results_checker_inventory: inv }, // 1 row for 2 ids
      { results_checker_orders: { data: ORDER }, results_checker_inventory: { data: null, error: { message: "x" } } },
      { results_checker_orders: { data: ORDER }, results_checker_inventory: "throw" },
      { results_checker_orders: { data: null, error: { message: "x" } } },
      { results_checker_orders: "throw" },
    ]
    for (const c of cases) {
      const { client } = fakeClient(c)
      expect(await fetchOwnedVouchers(client, "user-1", "RC-AAA-BBB")).toBeNull()
    }
  })
})

describe("order read, engine, alert, delivery", () => {
  it("order read is owner-scoped with the allow-listed columns", async () => {
    const { client, calls } = fakeClient({ results_checker_orders: { data: { reference_code: "RC-1" } } })
    expect(await fetchResultsOrderByCode(client, "u1", "RC-1")).toEqual({ reference_code: "RC-1" })
    expect(calls).toContainEqual(["results_checker_orders.select", RESULTS_ORDER_COLUMNS])
    expect(calls).toContainEqual(["results_checker_orders.eq", "user_id", "u1"])
    expect(RESULTS_ORDER_COLUMNS.split(",").map((s) => s.trim()).sort()).toEqual(
      ["created_at", "exam_board", "quantity", "reference_code", "status", "total_paid", "unit_price"]
    )
    expect(await fetchResultsOrderByCode(fakeClient({ results_checker_orders: "throw" }).client, "u1", "RC-1")).toBeNull()
  })

  it("the engine gets exactly { userId, examBoard, quantity }", async () => {
    await realResultsEngine({ userId: "u1", examBoard: "WASSCE", quantity: 2 })
    expect(purchaseResultsCheckerVouchers).toHaveBeenCalledWith({ userId: "u1", examBoard: "WASSCE", quantity: 2 })
    expect(Object.keys((purchaseResultsCheckerVouchers.mock.calls[0] as any)[0]).sort()).toEqual(["examBoard", "quantity", "userId"])
  })

  it("the alert uses type results_review and never throws", async () => {
    await realResultsAlert("msg")
    expect(notifyAdmins).toHaveBeenCalledWith("msg", "results_review", undefined, false)
    notifyAdmins.mockRejectedValueOnce(new Error("down"))
    await expect(realResultsAlert("msg")).resolves.toBeUndefined()
  })

  it("delivery persists the recipient contact owner-scoped, then delivers with the recipient fields", async () => {
    const { client, calls } = fakeClient({ results_checker_orders: { data: null } })
    await realResultsDeliver(client, { id: "o1", user_id: "u1", reference_code: "RC-1" }, [{ pin: "P", serial_number: "S" }], "0249990901", null)
    expect(calls).toContainEqual(["results_checker_orders.eq", "id", "o1"])
    expect(calls).toContainEqual(["results_checker_orders.eq", "user_id", "u1"])
    const [o] = deliverVouchers.mock.calls[0] as any[]
    expect(o).toMatchObject({ customer_phone: "0249990901", customer_email: null })
  })

  it("no contact => nothing persisted, nothing delivered", async () => {
    deliverVouchers.mockClear()
    const { client, calls } = fakeClient({})
    await realResultsDeliver(client, { id: "o1", user_id: "u1" }, [], null, null)
    expect(calls).toEqual([])
    expect(deliverVouchers).not.toHaveBeenCalled()
  })
})
