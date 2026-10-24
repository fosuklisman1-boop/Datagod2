import { describe, it, expect } from "vitest"
import {
  claimRequest,
  completeClaim,
  releaseClaim,
  markClaimUnknown,
  getClaimByReference,
  listClaims,
  findClaimByOrderRef,
  CLAIM_STALE_MS,
} from "./idempotency"

type Row = Record<string, any>
type Call = { op: string; payload?: any; filters: Array<[string, any]>; orders?: Array<{ col: string; ascending: boolean }>; limit?: number }

/** Fake that models UNIQUE (user_id, kind, reference) and records every query. */
function makeFake(opts: { throwOnFrom?: boolean; errorOps?: Record<string, any>; now?: () => number } = {}) {
  const rows: Row[] = []
  const calls: Call[] = []
  let seq = 0
  const clock = opts.now ?? (() => Date.now())

  const client = {
    from(table: string) {
      if (opts.throwOnFrom) throw new Error("boom")
      expect(table).toBe("api_v2_idempotency")
      const q: Call = { op: "select", filters: [] }
      let single: "single" | "maybe" | null = null
      const run = () => {
        calls.push(q)
        const err = opts.errorOps?.[q.op]
        if (err) return { data: null, error: err }
        const match = () => rows.filter((r) => q.filters.every(([c, v]) => r[c] === v))
        if (q.op === "insert") {
          const p = q.payload
          if (rows.some((r) => r.user_id === p.user_id && r.kind === p.kind && r.reference === p.reference)) {
            return { data: null, error: { code: "23505", message: "duplicate key" } }
          }
          const row = { id: `claim-${++seq}`, created_at: new Date(clock()).toISOString(), order_ref: null, response: null, completed_at: null, ...p }
          rows.push(row)
          return { data: single ? { id: row.id } : [{ id: row.id }], error: null }
        }
        if (q.op === "update") {
          const hit = match()
          hit.forEach((r) => Object.assign(r, q.payload))
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        if (q.op === "delete") {
          const hit = match()
          hit.forEach((r) => rows.splice(rows.indexOf(r), 1))
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        let out = match()
        if (q.orders) {
          const keys = q.orders
          out = [...out].sort((a, b) => {
            for (const k of keys) {
              if (a[k.col] === b[k.col]) continue
              return (a[k.col] < b[k.col] ? -1 : 1) * (k.ascending ? 1 : -1)
            }
            return 0
          })
        }
        if (q.limit !== undefined) out = out.slice(0, q.limit)
        if (single) return { data: out[0] ?? null, error: null }
        return { data: out, error: null }
      }
      const b: any = {
        insert(p: any) { q.op = "insert"; q.payload = p; return b },
        update(p: any) { q.op = "update"; q.payload = p; return b },
        delete() { q.op = "delete"; return b },
        select() { return b },
        eq(c: string, v: any) { q.filters.push([c, v]); return b },
        order(col: string, o: any) { (q.orders ??= []).push({ col, ascending: !!o?.ascending }); return b },
        limit(n: number) { q.limit = n; return b },
        single() { single = "single"; return Promise.resolve(run()) },
        maybeSingle() { single = "maybe"; return Promise.resolve(run()) },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
  return { client: client as any, rows, calls }
}

const H1 = "a".repeat(64)
const H2 = "b".repeat(64)
const P = { userId: "u1", apiV2KeyId: "k1", kind: "airtime" as const, reference: "REF-0501", requestHash: H1 }

describe("claimRequest", () => {
  it("inserts an in_progress row and returns claimed", async () => {
    const f = makeFake()
    const r = await claimRequest(f.client, P)
    expect(r).toEqual({ kind: "claimed", claimId: "claim-1" })
    expect(f.rows[0]).toMatchObject({ user_id: "u1", api_v2_key_id: "k1", kind: "airtime", reference: "REF-0501", request_hash: H1, status: "in_progress" })
  })

  it("same hash while in_progress => in_progress", async () => {
    const f = makeFake()
    await claimRequest(f.client, P)
    expect(await claimRequest(f.client, P)).toEqual({ kind: "in_progress" })
  })

  it("after completeClaim, same hash => replay with the stored response", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    expect(await completeClaim(f.client, c.claimId, "order-1", { reference: "REF-0501", total_paid: 5 })).toBe(true)
    expect(await claimRequest(f.client, P)).toEqual({ kind: "replay", orderRef: "order-1", response: { reference: "REF-0501", total_paid: 5 } })
  })

  it("completeClaim sets status done, order_ref, response and completed_at", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    await completeClaim(f.client, c.claimId, "order-1", { a: 1 })
    expect(f.rows[0]).toMatchObject({ status: "done", order_ref: "order-1", response: { a: 1 } })
    expect(typeof f.rows[0].completed_at).toBe("string")
    expect(Number.isNaN(Date.parse(f.rows[0].completed_at))).toBe(false)
  })

  it("different hash => conflict, in every state", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    expect(await claimRequest(f.client, { ...P, requestHash: H2 })).toEqual({ kind: "conflict" })
    if (c.kind !== "claimed") throw new Error("x")
    await completeClaim(f.client, c.claimId, "order-1", { a: 1 })
    expect(await claimRequest(f.client, { ...P, requestHash: H2 })).toEqual({ kind: "conflict" })
  })

  it("hash is checked first: an unknown row or a done row with a DIFFERENT hash => conflict", async () => {
    const f = makeFake()
    const u = await claimRequest(f.client, P)
    const d = await claimRequest(f.client, { ...P, reference: "REF-0502" })
    if (u.kind !== "claimed" || d.kind !== "claimed") throw new Error("x")
    expect(await markClaimUnknown(f.client, u.claimId)).toBe(true)
    expect(await completeClaim(f.client, d.claimId, "order-2", { a: 2 })).toBe(true)
    expect(await claimRequest(f.client, { ...P, requestHash: H2 })).toEqual({ kind: "conflict" })
    expect(await claimRequest(f.client, { ...P, reference: "REF-0502", requestHash: H2 })).toEqual({ kind: "conflict" })
    // same hash still reads its state
    expect(await claimRequest(f.client, P)).toEqual({ kind: "unknown" })
  })

  it("stale in_progress (clock +11 min) => unknown; 9 minutes => in_progress", async () => {
    let t = 1_700_000_000_000
    const f = makeFake({ now: () => t })
    await claimRequest(f.client, P, () => t)
    t += 9 * 60_000
    expect(await claimRequest(f.client, P, () => t)).toEqual({ kind: "in_progress" })
    t += 2 * 60_000
    expect(await claimRequest(f.client, P, () => t)).toEqual({ kind: "unknown" })
  })

  it("an unknown row => unknown", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    await markClaimUnknown(f.client, c.claimId)
    expect(f.rows[0].status).toBe("unknown")
    expect(await claimRequest(f.client, P)).toEqual({ kind: "unknown" })
  })

  it("a done row missing its order or response is an error, not a replay", async () => {
    const f = makeFake()
    await claimRequest(f.client, P)
    f.rows[0].status = "done"
    expect(await claimRequest(f.client, P)).toEqual({ kind: "error" })
  })

  it("an unreadable created_at on an in_progress row fails safe to unknown", async () => {
    const f = makeFake()
    await claimRequest(f.client, P)
    f.rows[0].created_at = "garbage"
    expect(await claimRequest(f.client, P)).toEqual({ kind: "unknown" })
  })

  it("same reference in another kind or for another user is a separate claim", async () => {
    const f = makeFake()
    await claimRequest(f.client, P)
    expect((await claimRequest(f.client, { ...P, kind: "bill" })).kind).toBe("claimed")
    expect((await claimRequest(f.client, { ...P, userId: "u2" })).kind).toBe("claimed")
  })

  it("the conflict read filters by user, kind and reference exactly", async () => {
    const f = makeFake()
    await claimRequest(f.client, P)
    await claimRequest(f.client, P)
    const read = f.calls.filter((c) => c.op === "select").at(-1)!
    expect(read.filters).toEqual([["user_id", "u1"], ["kind", "airtime"], ["reference", "REF-0501"]])
  })

  it("non-unique insert errors, read errors and a vanished row => error", async () => {
    expect(await claimRequest(makeFake({ errorOps: { insert: { code: "08006" } } }).client, P)).toEqual({ kind: "error" })
    const f = makeFake()
    await claimRequest(f.client, P)
    const g = makeFake({ errorOps: { select: { code: "XX" } } })
    g.rows.push(...f.rows)
    expect(await claimRequest(g.client, P)).toEqual({ kind: "error" })
    // 23505 raised but the row is gone by the time we read it
    const h = makeFake({ errorOps: { insert: { code: "23505" } } })
    expect(await claimRequest(h.client, P)).toEqual({ kind: "error" })
  })

  it("never throws", async () => {
    expect(await claimRequest(makeFake({ throwOnFrom: true }).client, P)).toEqual({ kind: "error" })
    expect(await claimRequest(null as any, P)).toEqual({ kind: "error" })
  })
})

describe("completeClaim / releaseClaim / markClaimUnknown", () => {
  it("releaseClaim deletes only an in_progress row", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    await completeClaim(f.client, c.claimId, "order-1", { a: 1 })
    expect(await releaseClaim(f.client, c.claimId)).toBe(false)
    expect(f.rows).toHaveLength(1)
    const del = f.calls.find((x) => x.op === "delete")!
    expect(del.filters).toContainEqual(["status", "in_progress"])
  })

  it("releaseClaim frees an in_progress reference and a new claim then succeeds", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    expect(await releaseClaim(f.client, c.claimId)).toBe(true)
    expect(f.rows).toHaveLength(0)
    expect((await claimRequest(f.client, P)).kind).toBe("claimed")
  })

  it("completeClaim after a release returns false, and only updates in_progress", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    await releaseClaim(f.client, c.claimId)
    expect(await completeClaim(f.client, c.claimId, "o", { a: 1 })).toBe(false)
    const upd = f.calls.find((x) => x.op === "update")!
    expect(upd.filters).toContainEqual(["status", "in_progress"])
    expect(upd.filters).toContainEqual(["id", c.claimId])
  })

  it("a done row cannot be completed again or marked unknown", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    await completeClaim(f.client, c.claimId, "order-1", { a: 1 })
    expect(await completeClaim(f.client, c.claimId, "order-2", { a: 2 })).toBe(false)
    expect(await markClaimUnknown(f.client, c.claimId)).toBe(false)
    expect(f.rows[0]).toMatchObject({ status: "done", order_ref: "order-1" })
  })

  it("completeClaim refuses an empty order ref or a null response without querying", async () => {
    const f = makeFake()
    expect(await completeClaim(f.client, "claim-1", "", { a: 1 })).toBe(false)
    expect(await completeClaim(f.client, "claim-1", "o", null)).toBe(false)
    expect(f.calls).toHaveLength(0)
  })

  it("completeClaim stamps completed_at from the injected clock", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    const t = Date.parse("2026-10-24T12:34:56.000Z")
    expect(await completeClaim(f.client, c.claimId, "order-1", { a: 1 }, () => t)).toBe(true)
    expect(f.rows[0].completed_at).toBe("2026-10-24T12:34:56.000Z")
  })

  it("with a wrong userId nothing is completed, released or marked (returns false)", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    expect(await completeClaim(f.client, c.claimId, "order-1", { a: 1 }, undefined, "u2")).toBe(false)
    expect(await markClaimUnknown(f.client, c.claimId, "u2")).toBe(false)
    expect(await releaseClaim(f.client, c.claimId, "u2")).toBe(false)
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({ status: "in_progress", order_ref: null, response: null })
    for (const call of f.calls.filter((x) => x.op !== "insert")) expect(call.filters).toContainEqual(["user_id", "u2"])
  })

  it("with the owner's userId each guarded write adds user_id and succeeds", async () => {
    const f = makeFake()
    const a = await claimRequest(f.client, P)
    const b = await claimRequest(f.client, { ...P, reference: "REF-0502" })
    const d = await claimRequest(f.client, { ...P, reference: "REF-0503" })
    if (a.kind !== "claimed" || b.kind !== "claimed" || d.kind !== "claimed") throw new Error("x")
    expect(await completeClaim(f.client, a.claimId, "order-1", { a: 1 }, undefined, "u1")).toBe(true)
    expect(await markClaimUnknown(f.client, b.claimId, "u1")).toBe(true)
    expect(await releaseClaim(f.client, d.claimId, "u1")).toBe(true)
    const writes = f.calls.filter((x) => x.op === "update" || x.op === "delete")
    expect(writes).toHaveLength(3)
    for (const w of writes) expect(w.filters).toContainEqual(["user_id", "u1"])
  })

  it("without userId the guarded writes do not filter by user (unchanged)", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    await markClaimUnknown(f.client, c.claimId)
    await releaseClaim(f.client, c.claimId)
    await completeClaim(f.client, c.claimId, "o", { a: 1 })
    for (const w of f.calls.filter((x) => x.op !== "insert")) {
      expect(w.filters.some(([col]) => col === "user_id")).toBe(false)
    }
  })

  it("swallow transport errors and exceptions, returning false", async () => {
    for (const errorOps of [{ update: { code: "X" } }, { delete: { code: "X" } }]) {
      const f = makeFake({ errorOps })
      expect(await completeClaim(f.client, "c", "o", { a: 1 })).toBe(false)
      expect(await releaseClaim(f.client, "c")).toBe(false)
      expect(await markClaimUnknown(f.client, "c")).toBe(false)
    }
    const t = makeFake({ throwOnFrom: true }).client
    expect(await completeClaim(t, "c", "o", { a: 1 })).toBe(false)
    expect(await releaseClaim(t, "c")).toBe(false)
    expect(await markClaimUnknown(t, "c")).toBe(false)
  })
})

describe("getClaimByReference / listClaims", () => {
  it("returns the owner's row and filters by user, kind and reference", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, P)
    if (c.kind !== "claimed") throw new Error("x")
    await completeClaim(f.client, c.claimId, "order-1", { a: 1 })
    expect(await getClaimByReference(f.client, "u1", "airtime", "REF-0501")).toEqual({
      orderRef: "order-1",
      status: "done",
      response: { a: 1 },
      createdAt: f.rows[0].created_at,
    })
    const q = f.calls.at(-1)!
    expect(q.filters).toEqual([["user_id", "u1"], ["kind", "airtime"], ["reference", "REF-0501"]])
  })

  it("another user's reference is null", async () => {
    const f = makeFake()
    await claimRequest(f.client, P)
    expect(await getClaimByReference(f.client, "u2", "airtime", "REF-0501")).toBeNull()
    expect(await getClaimByReference(f.client, "u1", "bill", "REF-0501")).toBeNull()
  })

  it("returns null on error or exception", async () => {
    expect(await getClaimByReference(makeFake({ errorOps: { select: { code: "X" } } }).client, "u1", "airtime", "R-1")).toBeNull()
    expect(await getClaimByReference(makeFake({ throwOnFrom: true }).client, "u1", "airtime", "R-1")).toBeNull()
  })

  it("listClaims is owner-scoped, newest first, and capped at 30", async () => {
    const f = makeFake()
    for (let i = 0; i < 45; i++) {
      const c = await claimRequest(f.client, { ...P, reference: `REF-L${String(i).padStart(3, "0")}` })
      if (c.kind !== "claimed") throw new Error("x")
      f.rows[f.rows.length - 1].created_at = new Date(1_700_000_000_000 + i * 1000).toISOString()
    }
    await claimRequest(f.client, { ...P, userId: "u2", reference: "REF-OTHER" })
    const out = await listClaims(f.client, "u1", "airtime", 500)
    expect(out).toHaveLength(30)
    expect(out[0].reference).toBe("REF-L044")
    expect(out.every((r) => r.reference.startsWith("REF-L"))).toBe(true)
    expect(Object.keys(out[0]).sort()).toEqual(["orderRef", "reference", "status"])
    const q = f.calls.at(-1)!
    expect(q.limit).toBe(30)
    expect(q.filters).toEqual([["user_id", "u1"], ["kind", "airtime"]])
    expect(await listClaims(f.client, "u1", "airtime", 5)).toHaveLength(5)
    expect(await listClaims(f.client, "u1", "airtime")).toHaveLength(30)
    expect(await listClaims(f.client, "u1", "airtime", Number.NaN)).toHaveLength(30)
  })

  it("listClaims orders by created_at desc then id desc (stable tie-breaker)", async () => {
    const f = makeFake()
    for (const ref of ["REF-T1", "REF-T2", "REF-T3"]) await claimRequest(f.client, { ...P, reference: ref })
    const same = new Date(1_700_000_000_000).toISOString()
    f.rows[0].id = "00000000-0000-0000-0000-00000000000a"
    f.rows[1].id = "00000000-0000-0000-0000-00000000000c"
    f.rows[2].id = "00000000-0000-0000-0000-00000000000b"
    for (const r of f.rows) r.created_at = same
    const out = await listClaims(f.client, "u1", "airtime")
    expect(out.map((r) => r.reference)).toEqual(["REF-T2", "REF-T3", "REF-T1"])
    expect(f.calls.at(-1)!.orders).toEqual([
      { col: "created_at", ascending: false },
      { col: "id", ascending: false },
    ])
  })

  it("listClaims returns [] on error or exception", async () => {
    expect(await listClaims(makeFake({ errorOps: { select: { code: "X" } } }).client, "u1", "bill")).toEqual([])
    expect(await listClaims(makeFake({ throwOnFrom: true }).client, "u1", "bill")).toEqual([])
  })
})

describe("fix wave: stale threshold, unknown with order_ref, done-only lists", () => {
  it("CLAIM_STALE_MS outlives the longest v2 purchase maxDuration (300 s), so a live request is never read as stale", () => {
    // Invariant: a claim may only read as OUTCOME_UNKNOWN once the request that owns it is certainly dead.
    // The longest maxDuration of any v2 purchase route is 300 s (airtime purchase).
    expect(CLAIM_STALE_MS).toBeGreaterThan(300_000)
    expect(CLAIM_STALE_MS).toBe(10 * 60 * 1000)
  })

  it("claimRequest uses CLAIM_STALE_MS: at the threshold in_progress, one ms past it unknown", async () => {
    let t = 1_700_000_000_000
    const f = makeFake({ now: () => t })
    const c = await claimRequest(f.client, P, () => t)
    if (c.kind !== "claimed") throw new Error("x")
    t += CLAIM_STALE_MS
    expect((await claimRequest(f.client, P, () => t)).kind).toBe("in_progress")
    t += 1
    expect((await claimRequest(f.client, P, () => t)).kind).toBe("unknown")
  })

  it("markClaimUnknown stores order_ref when given and keeps the unknown state", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, { ...P, kind: "bill" })
    if (c.kind !== "claimed") throw new Error("x")
    expect(await markClaimUnknown(f.client, c.claimId, "u1", "BILL-ENGINE-7")).toBe(true)
    expect(f.rows[0]).toMatchObject({ status: "unknown", order_ref: "BILL-ENGINE-7" })
    expect(f.calls.at(-1)!.payload).toEqual({ status: "unknown", order_ref: "BILL-ENGINE-7" })
  })

  it("markClaimUnknown without (or with an empty) orderRef writes only the status", async () => {
    for (const ref of [undefined, ""]) {
      const f = makeFake()
      const c = await claimRequest(f.client, P)
      if (c.kind !== "claimed") throw new Error("x")
      expect(await markClaimUnknown(f.client, c.claimId, "u1", ref)).toBe(true)
      expect(f.calls.at(-1)!.payload).toEqual({ status: "unknown" })
      expect(f.rows[0].order_ref).toBeNull()
    }
  })

  it("listClaims with status 'done' filters in the query, so the limit counts only done claims", async () => {
    const f = makeFake()
    for (let i = 0; i < 4; i++) {
      const c = await claimRequest(f.client, { ...P, reference: `REF-D${i}` })
      if (c.kind !== "claimed") throw new Error("x")
      f.rows[f.rows.length - 1].created_at = new Date(1_700_000_000_000 + i * 1000).toISOString()
      if (i % 2 === 0) await completeClaim(f.client, c.claimId, `O-${i}`, { a: i })
    }
    const out = await listClaims(f.client, "u1", "airtime", 2, { status: "done" })
    expect(out.map((r) => r.reference)).toEqual(["REF-D2", "REF-D0"])
    expect(f.calls.at(-1)!.filters).toEqual([["user_id", "u1"], ["kind", "airtime"], ["status", "done"]])
    // Default unchanged: every status, no status filter.
    expect(await listClaims(f.client, "u1", "airtime", 30)).toHaveLength(4)
    expect(f.calls.at(-1)!.filters).toEqual([["user_id", "u1"], ["kind", "airtime"]])
  })
})

describe("findClaimByOrderRef", () => {
  const B = { ...P, kind: "bill" as const, reference: "BILL-REF-0701" }

  it("finds the owner's bill claim linked to an engine order_ref, filtered by user, kind and order_ref", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, B)
    if (c.kind !== "claimed") throw new Error("x")
    await completeClaim(f.client, c.claimId, "BILL-ENGINE-1", { a: 1 })
    expect(await findClaimByOrderRef(f.client, "u1", "bill", "BILL-ENGINE-1")).toEqual([
      { reference: "BILL-REF-0701", status: "done" },
    ])
    const q = f.calls.at(-1)!
    expect(q.filters).toEqual([["user_id", "u1"], ["kind", "bill"], ["order_ref", "BILL-ENGINE-1"]])
    expect(q.limit).toBe(5)
  })

  it("another user's claim, another kind, or an unlinked order_ref is []", async () => {
    const f = makeFake()
    const c = await claimRequest(f.client, B)
    if (c.kind !== "claimed") throw new Error("x")
    await completeClaim(f.client, c.claimId, "BILL-ENGINE-1", { a: 1 })
    expect(await findClaimByOrderRef(f.client, "u2", "bill", "BILL-ENGINE-1")).toEqual([])
    expect(await findClaimByOrderRef(f.client, "u1", "airtime", "BILL-ENGINE-1")).toEqual([])
    expect(await findClaimByOrderRef(f.client, "u1", "bill", "BILL-ENGINE-2")).toEqual([])
  })

  it("returns null (not []) on a read error or exception, and refuses an empty order_ref without a query", async () => {
    expect(await findClaimByOrderRef(makeFake({ errorOps: { select: { code: "X" } } }).client, "u1", "bill", "O-1")).toBeNull()
    expect(await findClaimByOrderRef(makeFake({ throwOnFrom: true }).client, "u1", "bill", "O-1")).toBeNull()
    const f = makeFake()
    expect(await findClaimByOrderRef(f.client, "u1", "bill", "")).toBeNull()
    expect(f.calls).toHaveLength(0)
  })
})
