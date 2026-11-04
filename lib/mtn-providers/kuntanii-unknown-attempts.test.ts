import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock("@/lib/sms/notify", () => ({ notifyAdminsThrottled: vi.fn() }))

import { checkUnknownAttempts } from "./kuntanii-unknown-attempts"

type Row = Record<string, any>

const NOW = 10_000_000_000
const HOUR = 3_600_000

function makeDb(rows: Row[]) {
  const log = { limits: [] as number[], updates: [] as Array<{ id: string; patch: Row }> }
  function from(table: string) {
    expect(table).toBe("kuntanii_unknown_attempts")
    let filters: Array<(r: Row) => boolean> = []
    let op: "select" | "update" = "select"
    let payload: Row = {}
    let limitN: number | undefined
    const run = () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)))
      if (op === "update") {
        matched.forEach((r) => {
          Object.assign(r, payload)
          log.updates.push({ id: r.id, patch: payload })
        })
        return { data: null, error: null }
      }
      let out = matched
      if (limitN !== undefined) {
        out = out.slice(0, limitN)
        log.limits.push(limitN)
      }
      return { data: out, error: null }
    }
    const b: any = {
      select: () => b,
      update: (p: Row) => ((op = "update"), (payload = p), b),
      is: (c: string, v: any) => (filters.push((r) => (r[c] ?? null) === v), b),
      eq: (c: string, v: any) => (filters.push((r) => r[c] === v), b),
      order: () => b,
      limit: (n: number) => ((limitN = n), b),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { db: { from }, log }
}

const row = (over: Row = {}): Row => ({
  id: "u1",
  external_order_id: "ord-1-r2",
  order_id: "ord-1",
  order_type: "bulk",
  created_at: new Date(NOW - HOUR).toISOString(),
  resolved_at: null,
  last_status: null,
  ...over,
})

const clientReturning = (res: any) => ({ getOrder: vi.fn(async () => res) }) as any
const okBody = (data: any) => ({ ok: true, status: 200, data })

describe("checkUnknownAttempts", () => {
  it("404 younger than 24h stays unresolved", async () => {
    const rows = [row()]
    const { db } = makeDb(rows)
    const alert = vi.fn(async () => {})
    const r = await checkUnknownAttempts({
      db, alert, now: () => NOW, client: clientReturning({ ok: false, status: 404, message: "nf" }),
    })
    expect(rows[0].resolved_at).toBeNull()
    expect(alert).not.toHaveBeenCalled()
    expect(r).toEqual({ checked: 1, alerted: 0 })
  })

  it("404 older than 24h is resolved as not_found without alert", async () => {
    const rows = [row({ created_at: new Date(NOW - 25 * HOUR).toISOString() })]
    const { db } = makeDb(rows)
    const alert = vi.fn(async () => {})
    await checkUnknownAttempts({
      db, alert, now: () => NOW, client: clientReturning({ ok: false, status: 404, message: "nf" }),
    })
    expect(rows[0].resolved_at).toBeTruthy()
    expect(rows[0].last_status).toBe("not_found")
    expect(alert).not.toHaveBeenCalled()
  })

  it("found pending -> alert + resolved, message has no phone", async () => {
    const rows = [row()]
    const { db } = makeDb(rows)
    const alert = vi.fn(async () => {})
    const r = await checkUnknownAttempts({
      db, alert, now: () => NOW,
      client: clientReturning(okBody({ externalOrderId: "ord-1-r2", orders: [{ status: "pending", phoneNumber: "0241234567" }] })),
    })
    expect(alert).toHaveBeenCalledWith(
      "kuntanii_possible_double_delivery",
      "Kuntanii: possible double delivery",
      "order ord-1 attempt ord-1-r2 is processing at Kuntanii",
    )
    expect(rows[0].resolved_at).toBeTruthy()
    expect(rows[0].last_status).toBe("processing")
    expect(r).toEqual({ checked: 1, alerted: 1 })
  })

  it("found top-level status only (no orders) is aggregated too", async () => {
    const rows = [row()]
    const { db } = makeDb(rows)
    const alert = vi.fn(async () => {})
    await checkUnknownAttempts({
      db, alert, now: () => NOW, client: clientReturning(okBody({ externalOrderId: "x", orders: [], status: "processed" })),
    })
    expect(alert).toHaveBeenCalledTimes(1)
    expect(rows[0].last_status).toBe("completed")
  })

  it("found cancelled -> resolved, no alert", async () => {
    const rows = [row()]
    const { db } = makeDb(rows)
    const alert = vi.fn(async () => {})
    const r = await checkUnknownAttempts({
      db, alert, now: () => NOW,
      client: clientReturning(okBody({ externalOrderId: "x", orders: [{ status: "cancelled" }] })),
    })
    expect(alert).not.toHaveBeenCalled()
    expect(rows[0].resolved_at).toBeTruthy()
    expect(rows[0].last_status).toBe("failed")
    expect(r).toEqual({ checked: 1, alerted: 0 })
  })

  it("other errors leave the row untouched", async () => {
    const rows = [row()]
    const { db } = makeDb(rows)
    const alert = vi.fn(async () => {})
    await checkUnknownAttempts({
      db, alert, now: () => NOW, client: clientReturning({ ok: false, status: 500, message: "boom" }),
    })
    expect(rows[0].resolved_at).toBeNull()
    expect(alert).not.toHaveBeenCalled()
  })

  it("skips resolved rows and respects limit 20", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ id: `u${i}`, external_order_id: `e${i}` }))
    rows.push(row({ id: "done", resolved_at: new Date(NOW).toISOString() }))
    const { db, log } = makeDb(rows)
    const client = clientReturning({ ok: false, status: 404, message: "nf" })
    const r = await checkUnknownAttempts({ db, alert: vi.fn(async () => {}), now: () => NOW, client })
    expect(log.limits).toEqual([20])
    expect(r.checked).toBe(20)
    expect(client.getOrder).toHaveBeenCalledTimes(20)
  })

  it("an alert failure does not stop the remaining rows", async () => {
    const rows = [row({ id: "a", external_order_id: "ea" }), row({ id: "b", external_order_id: "eb" })]
    const { db } = makeDb(rows)
    const alert = vi.fn(async () => {
      throw new Error("sms down")
    })
    const r = await checkUnknownAttempts({
      db, alert, now: () => NOW,
      client: clientReturning(okBody({ externalOrderId: "x", orders: [{ status: "pending" }] })),
    })
    expect(r.checked).toBe(2)
    expect(rows.every((x) => x.resolved_at)).toBe(true)
  })
})
