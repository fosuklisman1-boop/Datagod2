import { describe, it, expect, vi, beforeEach } from "vitest"

type Result = { data: any; error: null | { message: string } }

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Result[]>,
  ops: [] as { table: string; ops: { m: string; args: any[] }[] }[],
  rpcCalls: [] as { fn: string; args: any }[],
  rpcResults: {} as Record<string, Result>,
  dispatch: vi.fn(),
}))

vi.mock("./campaign-dispatch", () => ({ dispatchCampaign: h.dispatch }))

import { claimPendingForLog, dispatchClaimed } from "./dispatch-claimed"

const db: any = {
  rpc: (fn: string, args: any) => {
    h.rpcCalls.push({ fn, args })
    return Promise.resolve(h.rpcResults[fn] ?? { data: null, error: null })
  },
  from: (table: string) => {
    const ops: { m: string; args: any[] }[] = []
    h.ops.push({ table, ops })
    const q = h.tables[table] ?? []
    const result: Result = q.length > 1 ? q.shift()! : q[0] ?? { data: null, error: null }
    const c: any = {}
    for (const m of ["select", "update", "insert", "eq", "in", "not", "order", "limit", "maybeSingle", "single"]) {
      c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
    }
    c.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
    return c
  },
}

function updates(table: string) { return h.ops.filter((o) => o.table === table && o.ops.some((x) => x.m === "update")) }
function patchOf(o: { ops: { m: string; args: any[] }[] }) { return o.ops.find((x) => x.m === "update")!.args[0] }
function eqs(o: { ops: { m: string; args: any[] }[] }) { return o.ops.filter((x) => x.m === "eq").map((x) => x.args) }

beforeEach(() => {
  h.tables = {}
  h.ops = []
  h.rpcCalls = []
  h.rpcResults = {}
  h.dispatch.mockReset()
})

describe("claimPendingForLog", () => {
  it("claims the log's pending rows conditionally and maps them to dispatch items", async () => {
    h.tables = { sms_messages: [{ data: [{ id: "m1", phone: "+233241111111", rendered_message: "Hi" }], error: null }] }
    const items = await claimPendingForLog(db, 42)
    expect(items).toEqual([{ id: "m1", phone: "+233241111111", message: "Hi" }])
    const [u] = updates("sms_messages")
    expect(patchOf(u)).toMatchObject({ status: "claimed" })
    expect(typeof patchOf(u).claimed_at).toBe("string")
    expect(eqs(u)).toEqual([["send_log_id", 42], ["status", "pending"]])
  })

  it("returns [] on a claim error (the drain will send the campaign)", async () => {
    h.tables = { sms_messages: [{ data: [{ id: "m1", phone: "p", rendered_message: "x" }], error: { message: "boom" } }] }
    expect(await claimPendingForLog(db, 42)).toEqual([])
  })

  it("returns [] when nothing is pending", async () => {
    h.tables = { sms_messages: [{ data: null, error: null }] }
    expect(await claimPendingForLog(db, 42)).toEqual([])
  })
})

describe("dispatchClaimed", () => {
  const items = [
    { id: "m1", phone: "+233241111111", message: "Hello" },
    { id: "m2", phone: "+233242222222", message: "Hello" },
  ]

  it("passes the provider through as dispatchCampaign's last argument", async () => {
    h.dispatch.mockResolvedValue({ provider: "hubtel", sent: [], fallbackSent: [], outOfFunds: false })
    await dispatchClaimed(db, 42, items, "MYSHOP", Date.now(), "hubtel")
    expect(h.dispatch.mock.calls[0][4]).toBe("hubtel")
    h.dispatch.mockClear()
    await dispatchClaimed(db, 42, items, "MYSHOP", Date.now())
    expect(h.dispatch.mock.calls[0][4]).toBeUndefined()
  })

  it("marks sent, records first batch id, hands back unplaced rows scoped to this call, recomputes", async () => {
    h.dispatch.mockImplementation(async (its: any[], _s: any, mark: any) => {
      await mark("hubtel", [{ id: its[0].id, mid: "mid1", bid: "b1" }], { unconfirmed: false })
      return { provider: "hubtel", sent: [{ id: its[0].id, mid: "mid1", bid: "b1" }], fallbackSent: [], outOfFunds: false }
    })
    const placed = await dispatchClaimed(db, 42, items, "MYSHOP", Date.now())
    expect(placed).toBe(1)
    expect(h.dispatch.mock.calls[0][1]).toBe("MYSHOP")
    expect(h.rpcCalls.find((c) => c.fn === "mark_sms_messages_sent")!.args).toEqual({ p_provider: "hubtel", p_rows: [{ id: "m1", mid: "mid1", bid: "b1" }] })
    expect(patchOf(updates("sms_send_logs")[0])).toEqual({ provider_batch_id: "b1", provider: "hubtel" })
    const back = updates("sms_messages")[0]
    expect(patchOf(back)).toEqual({ status: "pending", claimed_at: null })
    expect(back.ops.find((x) => x.m === "in")!.args).toEqual(["id", ["m1", "m2"]])
    expect(h.rpcCalls.find((c) => c.fn === "recompute_sms_send_result")!.args).toEqual({ p_send_log_id: 42, max_attempts: 3 })
  })

  it("tags hubtel unconfirmed rows", async () => {
    h.dispatch.mockImplementation(async (its: any[], _s: any, mark: any) => {
      await mark("hubtel", [{ id: "m1", mid: null, bid: null }], { unconfirmed: true })
      return { provider: "hubtel", sent: [], fallbackSent: [], outOfFunds: false }
    })
    await dispatchClaimed(db, 42, items, null, Date.now())
    const tag = updates("sms_messages").find((o) => patchOf(o).last_error === "hubtel_unconfirmed")
    expect(tag).toBeTruthy()
    expect(tag!.ops.find((x) => x.m === "in")!.args).toEqual(["id", ["m1"]])
  })

  it("hand-back is chunked (100 ids) and excludes placed-but-unmarked rows", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, phone: "+233241111111", message: "Hi" }))
    h.tables = { sms_messages: [{ data: null, error: { message: "fallback down" } }, { data: null, error: null }] }
    h.rpcResults.mark_sms_messages_sent = { data: null, error: { message: "rpc down" } }
    h.dispatch.mockImplementation(async (_i: any[], _s: any, mark: any) => {
      await mark("moolre", [{ id: "m0", mid: null, bid: null }], { unconfirmed: false })
      return { provider: "moolre", sent: [{ id: "m0", mid: null, bid: null }], fallbackSent: [], outOfFunds: false }
    })
    await dispatchClaimed(db, 42, rows, null, Date.now())
    const handBacks = updates("sms_messages").filter((o) => patchOf(o).status === "pending")
    const ids = handBacks.map((o) => o.ops.find((x) => x.m === "in")!.args[1] as string[])
    expect(ids.map((a) => a.length)).toEqual([100, 100, 49])
    expect(ids.flat()).not.toContain("m0")
  }, 10_000)

  it("a dispatch throw still hands back claimed rows and recomputes", async () => {
    h.dispatch.mockRejectedValue(new Error("provider down"))
    expect(await dispatchClaimed(db, 42, items, null, Date.now())).toBe(0)
    expect(updates("sms_messages")).toHaveLength(1)
    expect(h.rpcCalls.some((c) => c.fn === "recompute_sms_send_result")).toBe(true)
  })

  it("recompute failure is non-fatal", async () => {
    h.dispatch.mockResolvedValue({ provider: "hubtel", sent: [], fallbackSent: [], outOfFunds: false })
    h.rpcResults.recompute_sms_send_result = { data: null, error: { message: "nope" } }
    await expect(dispatchClaimed(db, 42, items, null, Date.now())).resolves.toBe(0)
  })

  it("no items: no dispatch, no hand-back, still recomputes", async () => {
    expect(await dispatchClaimed(db, 42, [], null, Date.now())).toBe(0)
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(updates("sms_messages")).toHaveLength(0)
    expect(h.rpcCalls.some((c) => c.fn === "recompute_sms_send_result")).toBe(true)
  })
})
