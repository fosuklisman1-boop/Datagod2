import { describe, it, expect, vi, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import {
  dedupeKey, storeInbound, setInboundResult, storeOutbound, isBlocked, counts, globalPrompts, countOutbound, hasOpenOrder, linkOrder,
  loadConversation, saveConversation, touchHeartbeat, TtbStoreError,
  watchedLinks, ussdOrderForNotify, addNotice, patchLink, strandedInbound, getHeartbeat, purgeOld,
  claimInbound, linkByOrderId, closeStaleLinks, getInboundOutcome, latestOrderLink, ussdOrderStatus, orderRowFor,
} from "./store"
import { ORDER_TABLE_OF } from "./types"

const S = "0200000101"
const now = new Date("2026-11-13T12:00:00Z")
const mk = (seed = {}) => {
  const f = makeFakeTtb(seed)
  return { db: f.db, c: f.client as unknown as SupabaseClient }
}
const dup = { code: "23505", message: "duplicate key" }

afterEach(() => vi.restoreAllMocks())

describe("dedupeKey", () => {
  const t1 = new Date("2026-11-13T11:59:00Z")
  const t2 = new Date("2026-11-13T11:59:01Z")
  it("is a sha256 hex, equal for the same receive time and different for different ones", () => {
    const a = dedupeKey("main", S, "1GB to 0200000150", t1, now)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(dedupeKey("main", S, "1GB to 0200000150", t1, new Date("2030-01-01"))).toBe(a)
    expect(dedupeKey("main", S, "1GB to 0200000150", t2, now)).not.toBe(a)
  })
  it("differs by line, sender and text", () => {
    const a = dedupeKey("main", S, "x", t1, now)
    expect(dedupeKey("shop", S, "x", t1, now)).not.toBe(a)
    expect(dedupeKey("main", "0200000102", "x", t1, now)).not.toBe(a)
    expect(dedupeKey("main", S, "y", t1, now)).not.toBe(a)
  })
  it("with no receive time: equal inside a 2-minute bucket, different across buckets", () => {
    const base = Date.parse("2026-11-13T12:00:00Z") // a bucket boundary
    const k = (ms: number) => dedupeKey("main", S, "x", null, new Date(base + ms))
    expect(k(0)).toBe(k(119_999))
    expect(k(0)).not.toBe(k(120_000))
    expect(k(0)).not.toBe(dedupeKey("main", S, "x", t1, new Date(base)))
  })
})

describe("storeInbound", () => {
  const m = { line: "main" as const, sender: S, body: "1GB to 0200000150", receivedAt: new Date("2026-11-13T11:59:00Z"), now }

  it("stores a row with the dedupe key and returns its id", async () => {
    const { db, c } = mk()
    const r = await storeInbound(c, m)
    expect(r.duplicate).toBe(false)
    expect(db.tables.ttb_messages).toHaveLength(1)
    expect(db.tables.ttb_messages[0]).toMatchObject({
      id: r.id, line: "main", sender: S, direction: "in", body: m.body, received_at: m.receivedAt.toISOString(),
      dedupe_key: dedupeKey("main", S, m.body, m.receivedAt, now),
    })
  })

  it("stores a null receive time as null", async () => {
    const { db, c } = mk()
    await storeInbound(c, { ...m, receivedAt: null })
    expect(db.tables.ttb_messages[0].received_at).toBeNull()
  })

  it("returns duplicate: true with the first row's id on a unique violation", async () => {
    const { db, c } = mk()
    const first = await storeInbound(c, m)
    const second = await storeInbound(c, m)
    expect(second).toEqual({ id: first.id, duplicate: true })
    expect(db.tables.ttb_messages).toHaveLength(1)
  })

  it("throws TtbStoreError on any other error, without the text or number in the message", async () => {
    const { db, c } = mk()
    db.failOn.ttb_messages = { code: "08006", message: `connection failure while writing ${m.body} for ${S}` }
    const err = await storeInbound(c, m).catch((e) => e)
    expect(err).toBeInstanceOf(TtbStoreError)
    expect(String(err.message)).not.toContain(m.body)
    expect(String(err.message)).not.toContain(S)
  })

  it("throws TtbStoreError when a duplicate's original row cannot be found", async () => {
    const { db, c } = mk()
    db.failOn.ttb_messages = dup
    await expect(storeInbound(c, m)).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("setInboundResult / storeOutbound", () => {
  it("records who read the text, the outcome and the order link", async () => {
    const { db, c } = mk()
    const { id } = await storeInbound(c, { line: "shop", sender: S, body: "hi", receivedAt: null, now })
    await setInboundResult(c, id, { readBy: "rules", outcome: "prompted", orderLinkId: "6f0c1a9e-0163-4163-8163-000000000009" })
    expect(db.tables.ttb_messages[0]).toMatchObject({ read_by: "rules", outcome: "prompted", order_link_id: "6f0c1a9e-0163-4163-8163-000000000009" })
  })

  it("leaves the order link out when there is none, and allows a null reader", async () => {
    const { db, c } = mk()
    const { id } = await storeInbound(c, { line: "main", sender: S, body: "hi", receivedAt: null, now })
    await setInboundResult(c, id, { readBy: null, outcome: "off" })
    expect(db.tables.ttb_messages[0]).toMatchObject({ read_by: null, outcome: "off" })
    expect(db.tables.ttb_messages[0].order_link_id).toBeUndefined()
  })

  it("stores an outbound row with no dedupe key", async () => {
    const { db, c } = mk()
    await storeOutbound(c, { line: "main", sender: S, body: "Reply" })
    expect(db.tables.ttb_messages[0]).toMatchObject({ line: "main", sender: S, direction: "out", body: "Reply" })
    expect(db.tables.ttb_messages[0].dedupe_key).toBeUndefined()
  })

  it("throws TtbStoreError when a write fails", async () => {
    const { db, c } = mk()
    db.failOn.ttb_messages = { message: "down" }
    await expect(setInboundResult(c, "id", { readBy: null, outcome: "off" })).rejects.toBeInstanceOf(TtbStoreError)
    await expect(storeOutbound(c, { line: "main", sender: S, body: "x" })).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("isBlocked", () => {
  it("is true only for a blocked sender", async () => {
    const { c } = mk({ ttb_blocked: [{ sender: S }] })
    expect(await isBlocked(c, S)).toBe(true)
    expect(await isBlocked(c, "0200000102")).toBe(false)
  })
  it("throws TtbStoreError on a read error (the caller must fail closed)", async () => {
    const { db, c } = mk()
    db.failOn.ttb_blocked = { message: "down" }
    await expect(isBlocked(c, S)).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("counts / globalPrompts", () => {
  it("calls ttb_counts with its exact argument names and maps the row", async () => {
    const { db, c } = mk()
    db.rpcImpl = () => ({ data: [{ prompts_unpaid: 2, replies: 3, ai_reads: 4, not_understood: 1 }], error: null })
    const since = new Date("2026-11-13T11:00:00Z")
    expect(await counts(c, "main", S, since)).toEqual({ promptsUnpaid: 2, replies: 3, aiReads: 4, notUnderstood: 1 })
    expect(db.rpcCalls).toEqual([{ name: "ttb_counts", args: { p_line: "main", p_sender: S, p_since: since.toISOString() } }])
  })

  it("accepts a single object as well as an array, and treats a missing row as zeros", async () => {
    const { db, c } = mk()
    db.rpcImpl = () => ({ data: { prompts_unpaid: 1, replies: 0, ai_reads: 0, not_understood: 0 }, error: null })
    expect((await counts(c, "main", S, now)).promptsUnpaid).toBe(1)
    db.rpcImpl = () => ({ data: [], error: null })
    expect(await counts(c, "main", S, now)).toEqual({ promptsUnpaid: 0, replies: 0, aiReads: 0, notUnderstood: 0 })
  })

  it("throws TtbStoreError on an rpc error", async () => {
    const { db, c } = mk()
    db.rpcImpl = () => ({ data: null, error: { message: "down" } })
    await expect(counts(c, "main", S, now)).rejects.toBeInstanceOf(TtbStoreError)
    await expect(globalPrompts(c, now)).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("globalPrompts returns the scalar", async () => {
    const { db, c } = mk()
    db.rpcImpl = () => ({ data: 7, error: null })
    expect(await globalPrompts(c, now)).toBe(7)
    expect(db.rpcCalls[0]).toEqual({ name: "ttb_global_prompts", args: { p_since: now.toISOString() } })
  })
})

describe("countOutbound", () => {
  const since = new Date("2026-11-13T11:00:00Z")
  it("counts only outbound rows of that line created at or after since", async () => {
    const { c } = mk({
      ttb_messages: [
        { id: "1", line: "main", direction: "out", created_at: since.toISOString() },
        { id: "2", line: "main", direction: "out", created_at: now.toISOString() },
        { id: "3", line: "main", direction: "out", created_at: "2026-11-13T10:59:59.000Z" },
        { id: "4", line: "main", direction: "in", created_at: now.toISOString() },
        { id: "5", line: "shop", direction: "out", created_at: now.toISOString() },
      ],
    })
    expect(await countOutbound(c, "main", since)).toBe(2)
    expect(await countOutbound(c, "shop", since)).toBe(1)
    expect(await countOutbound(c, "main", new Date("2026-11-13T13:00:00Z"))).toBe(0)
  })
  it("throws TtbStoreError on a read error (the caller decides the fail-safe)", async () => {
    const { db, c } = mk()
    db.failOn.ttb_messages = { message: "down" }
    await expect(countOutbound(c, "main", since)).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("hasOpenOrder / linkOrder", () => {
  const o = { line: "main" as const, sender: S, service: "data" as const, orderTable: "ussd_orders" as const, orderId: "6f0c1a9e-0163-4163-8163-0000000000a1", size: "1GB", recipient: "0200000150", gift: false, amount: 5 }

  it("hasOpenOrder sees an awaiting_payment link created at or after windowStart", async () => {
    const start = new Date("2026-11-13T11:55:00Z")
    const { c } = mk({
      ttb_orders: [
        { id: "a", line: "main", sender: S, state: "awaiting_payment", created_at: start.toISOString() },
        { id: "b", line: "shop", sender: "0200000102", state: "awaiting_payment", created_at: now.toISOString() },
        { id: "c", line: "main", sender: "0200000103", state: "closed", created_at: now.toISOString() },
        { id: "d", line: "main", sender: "0200000104", state: "awaiting_payment", created_at: "2026-11-13T11:54:59.000Z" },
      ],
    })
    expect(await hasOpenOrder(c, "main", S, start)).toBe(true)
    expect(await hasOpenOrder(c, "shop", "0200000102", start)).toBe(true)
    expect(await hasOpenOrder(c, "main", "0200000103", start)).toBe(false) // closed
    expect(await hasOpenOrder(c, "main", "0200000104", start)).toBe(false) // before the window
    expect(await hasOpenOrder(c, "shop", S, start)).toBe(false) // another line
  })

  it("linkOrder inserts an awaiting_payment row and returns its id", async () => {
    const { db, c } = mk()
    const r = await linkOrder(c, o)
    expect(r).toEqual({ id: db.tables.ttb_orders[0].id })
    expect(db.tables.ttb_orders[0]).toMatchObject({
      line: "main", sender: S, order_id: o.orderId, size: "1GB", recipient: "0200000150", gift: false, amount: 5, state: "awaiting_payment",
    })
  })

  it("linkOrder returns 'conflict' only when the open-order index is violated (another text won)", async () => {
    const { c } = mk()
    await linkOrder(c, o)
    expect(await linkOrder(c, { ...o, orderId: "6f0c1a9e-0163-4163-8163-0000000000a2" })).toBe("conflict") // same (line, sender) open
  })

  it("linkOrder returns alreadyLinked with the existing id when the order_id key is violated (a retry)", async () => {
    const { db, c } = mk()
    const first = (await linkOrder(c, o)) as { id: string }
    expect(await linkOrder(c, o)).toEqual({ id: first.id, alreadyLinked: true })
    // a different sender with the same order id is the same case
    expect(await linkOrder(c, { ...o, sender: "0200000102" })).toEqual({ id: first.id, alreadyLinked: true })
    expect(db.tables.ttb_orders).toHaveLength(1)
  })

  it("linkOrder decides an unnamed 23505 by whether a row with that order_id exists", async () => {
    const { db, c } = mk({ ttb_orders: [{ id: "existing-link", line: "main", sender: S, order_id: o.orderId, state: "paid" }] })
    db.failInsert.ttb_orders = dup // no constraint name; the lookup afterwards reads normally
    expect(await linkOrder(c, o)).toEqual({ id: "existing-link", alreadyLinked: true })
  })

  it("linkOrder: an unnamed 23505 with no row for that order_id is 'conflict'", async () => {
    const { db, c } = mk()
    db.failInsert.ttb_orders = dup
    expect(await linkOrder(c, o)).toBe("conflict")
  })

  it("linkOrder throws if the order_id violation's existing row cannot be found, and on any other error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_orders = { code: "23505", message: 'duplicate key value violates unique constraint "ttb_orders_order_id_key"' }
    await expect(linkOrder(c, o)).rejects.toBeInstanceOf(TtbStoreError)
    db.failOn.ttb_orders = { code: "08006", message: "down" }
    await expect(linkOrder(c, o)).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("linkOrder never puts the database error text in the thrown error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_orders = { code: "08006", message: `secret ${S}` }
    const err = await linkOrder(c, o).catch((e) => e)
    expect(String(err.message)).not.toContain(S)
  })
})

describe("conversations", () => {
  const read = { kind: "order", service: "data", sizeMb: 1000, networkHint: "MTN", recipient: "0200000150", bare: false } as const
  const lastOrder = { sizeMb: 1000, network: "MTN", recipient: "0200000150" }

  it("returns an empty conversation when there is no row", async () => {
    const { c } = mk()
    expect(await loadConversation(c, "main", S, now)).toEqual({ turns: [], pending: null, lastOrder: null })
  })

  it("returns turns, pending and lastOrder while the conversation is live", async () => {
    const { c } = mk()
    const conv = { turns: [{ role: "user" as const, text: "hi" }], pending: { type: "confirm" as const, read }, lastOrder }
    await saveConversation(c, "main", S, conv, now)
    expect(await loadConversation(c, "main", S, new Date(now.getTime() + 19 * 60_000))).toEqual(conv)
  })

  it("an expired conversation has empty turns and null pending but keeps lastOrder", async () => {
    const { c } = mk()
    await saveConversation(c, "main", S, { turns: [{ role: "user", text: "hi" }], pending: { type: "confirm", read }, lastOrder }, now)
    expect(await loadConversation(c, "main", S, new Date(now.getTime() + 21 * 60_000))).toEqual({ turns: [], pending: null, lastOrder })
  })

  it("saveConversation sets expires_at to now + 20 minutes and keeps only the last 6 turns", async () => {
    const { db, c } = mk()
    const turns = Array.from({ length: 9 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `t${i}` }))
    await saveConversation(c, "main", S, { turns, pending: null, lastOrder: null }, now)
    const row = db.tables.ttb_conversations[0]
    expect(row.expires_at).toBe(new Date(now.getTime() + 20 * 60_000).toISOString())
    expect((row.turns as { text: string }[]).map((t) => t.text)).toEqual(["t3", "t4", "t5", "t6", "t7", "t8"])
  })

  it("saving twice updates the one row for (line, sender)", async () => {
    const { db, c } = mk()
    await saveConversation(c, "main", S, { turns: [], pending: null, lastOrder: null }, now)
    await saveConversation(c, "main", S, { turns: [], pending: null, lastOrder }, now)
    await saveConversation(c, "shop", S, { turns: [], pending: null, lastOrder: null }, now)
    expect(db.tables.ttb_conversations).toHaveLength(2)
    expect((await loadConversation(c, "main", S, now)).lastOrder).toEqual(lastOrder)
  })

  it("ignores malformed stored turns and a malformed lastOrder", async () => {
    const { c } = mk({
      ttb_conversations: [{ line: "main", sender: S, turns: [{ role: "user", text: "ok" }, { role: "robot", text: "x" }, "bad", { role: "user" }], pending: "nonsense", last_order: { sizeMb: "big" }, expires_at: new Date(now.getTime() + 60_000).toISOString() }],
    })
    expect(await loadConversation(c, "main", S, now)).toEqual({ turns: [{ role: "user", text: "ok" }], pending: null, lastOrder: null })
  })

  it("round-trips a pending quantity question and drops one with an unknown board", async () => {
    const { c } = mk()
    await saveConversation(c, "main", S, { turns: [], pending: { type: "quantity", board: "BECE" }, lastOrder: null }, now)
    expect((await loadConversation(c, "main", S, now)).pending).toEqual({ type: "quantity", board: "BECE" })
    const bad = mk({
      ttb_conversations: [{ line: "main", sender: S, turns: [], pending: { type: "quantity", board: "GCE" }, last_order: null, expires_at: new Date(now.getTime() + 60_000).toISOString() }],
    })
    expect((await loadConversation(bad.c, "main", S, now)).pending).toBeNull()
  })

  it("round-trips the airtime and results-checker lastOrder shapes", async () => {
    for (const lo of [
      { service: "airtime" as const, amountGhs: 10.5, network: "MTN", recipient: "0200000150" },
      { service: "results_checker" as const, board: "WASSCE" as const, quantity: 2 },
    ]) {
      const { c } = mk()
      await saveConversation(c, "main", S, { turns: [], pending: null, lastOrder: lo }, now)
      expect((await loadConversation(c, "main", S, now)).lastOrder).toEqual(lo)
    }
  })

  it("rejects malformed airtime and results-checker lastOrder rows, and still accepts a stored Stage 1 row", async () => {
    const bad = [
      { service: "airtime", amountGhs: "10", network: "MTN", recipient: "0200000150" },
      { service: "airtime", amountGhs: Number.NaN, network: "MTN", recipient: "0200000150" },
      { service: "airtime", amountGhs: 0, network: "MTN", recipient: "0200000150" },
      { service: "airtime", amountGhs: 10, network: "MTN" },
      { service: "results_checker", board: "GCE", quantity: 2 },
      { service: "results_checker", board: "BECE", quantity: 0 },
      { service: "results_checker", board: "BECE", quantity: 1.5 },
      { service: "nonsense", sizeMb: 1000, network: "MTN", recipient: "0200000150" },
    ]
    for (const last_order of bad) {
      const { c } = mk({ ttb_conversations: [{ line: "main", sender: S, turns: [], pending: null, last_order, expires_at: new Date(now.getTime() + 60_000).toISOString() }] })
      expect((await loadConversation(c, "main", S, now)).lastOrder).toBeNull()
    }
    const { c } = mk({ ttb_conversations: [{ line: "main", sender: S, turns: [], pending: null, last_order: lastOrder, expires_at: new Date(now.getTime() + 60_000).toISOString() }] })
    expect((await loadConversation(c, "main", S, now)).lastOrder).toEqual(lastOrder)
  })

  it("throws TtbStoreError on a read or write error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_conversations = { message: "down" }
    await expect(loadConversation(c, "main", S, now)).rejects.toBeInstanceOf(TtbStoreError)
    await expect(saveConversation(c, "main", S, { turns: [], pending: null, lastOrder: null }, now)).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("touchHeartbeat", () => {
  it("upserts one row per line", async () => {
    const { db, c } = mk()
    await touchHeartbeat(c, "main", now)
    await touchHeartbeat(c, "main", new Date(now.getTime() + 1000))
    await touchHeartbeat(c, "shop", now)
    expect(db.tables.ttb_heartbeat).toHaveLength(2)
    expect(db.tables.ttb_heartbeat.find((r) => r.line === "main")?.last_seen_at).toBe(new Date(now.getTime() + 1000).toISOString())
  })
  it("throws TtbStoreError on an error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_heartbeat = { message: "down" }
    await expect(touchHeartbeat(c, "main", now)).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("logging", () => {
  it("never writes message bodies or numbers to the console, even on failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    const { db, c } = mk()
    await storeInbound(c, { line: "main", sender: S, body: "secret body", receivedAt: null, now })
    db.failOn.ttb_messages = { message: "down secret body" }
    await storeInbound(c, { line: "main", sender: S, body: "secret body 2", receivedAt: null, now }).catch(() => {})
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})

describe("Task 10 store additions", () => {
  const O1 = "6f0c1a9e-0163-4163-8163-0000000000b1"
  const O2 = "6f0c1a9e-0163-4163-8163-0000000000b2"

  it("linkByOrderId finds a link by its order id, else null", async () => {
    const { c } = mk({ ttb_orders: [{ id: "L1", line: "main", sender: S, order_id: O1, state: "awaiting_payment" }] })
    expect(await linkByOrderId(c, O1)).toEqual({ id: "L1" })
    expect(await linkByOrderId(c, O2)).toBeNull()
  })

  it("linkByOrderId throws TtbStoreError on a read error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_orders = { message: "down" }
    await expect(linkByOrderId(c, O1)).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("closeStaleLinks closes only this sender's awaiting_payment links older than the window, and counts them", async () => {
    const start = new Date("2026-11-13T11:55:00Z")
    const { db, c } = mk({
      ttb_orders: [
        { id: "old", line: "main", sender: S, state: "awaiting_payment", created_at: "2026-11-13T11:50:00.000Z" },
        { id: "fresh", line: "main", sender: S, state: "awaiting_payment", created_at: "2026-11-13T11:56:00.000Z" },
        { id: "other", line: "main", sender: "0200000102", state: "awaiting_payment", created_at: "2026-11-13T11:50:00.000Z" },
        { id: "shop", line: "shop", sender: S, state: "awaiting_payment", created_at: "2026-11-13T11:50:00.000Z" },
        { id: "paid", line: "main", sender: S, state: "paid", created_at: "2026-11-13T11:40:00.000Z" },
      ],
    })
    expect(await closeStaleLinks(c, "main", S, start, now)).toBe(1)
    const by = (id: string) => db.tables.ttb_orders.find((r) => r.id === id)!
    expect(by("old")).toMatchObject({ state: "closed", closed_at: now.toISOString() })
    expect(by("fresh").state).toBe("awaiting_payment")
    expect(by("other").state).toBe("awaiting_payment")
    expect(by("shop").state).toBe("awaiting_payment")
    expect(by("paid").state).toBe("paid")
  })

  it("closeStaleLinks frees the open-order slot for a new link", async () => {
    const { c } = mk({ ttb_orders: [{ id: "old", line: "main", sender: S, order_id: O1, state: "awaiting_payment", created_at: "2026-11-13T11:00:00.000Z" }] })
    await closeStaleLinks(c, "main", S, new Date("2026-11-13T11:55:00Z"), now)
    const r = await linkOrder(c, { line: "main", sender: S, service: "data", orderTable: "ussd_orders", orderId: O2, size: "1GB", recipient: S, gift: false, amount: 5 })
    expect(r).not.toBe("conflict")
  })

  it("closeStaleLinks throws TtbStoreError on an error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_orders = { message: "down" }
    await expect(closeStaleLinks(c, "main", S, now, now)).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("getInboundOutcome returns the outcome, null when not yet processed, null when the row is missing", async () => {
    const { c } = mk({ ttb_messages: [{ id: "m1", outcome: "prompted" }, { id: "m2", outcome: null }] })
    expect(await getInboundOutcome(c, "m1")).toBe("prompted")
    expect(await getInboundOutcome(c, "m2")).toBeNull()
    expect(await getInboundOutcome(c, "nope")).toBeNull()
  })

  it("getInboundOutcome throws TtbStoreError on a read error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_messages = { message: "down" }
    await expect(getInboundOutcome(c, "m1")).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("latestOrderLink returns this sender's newest link on this line, mapped to camelCase; null when none", async () => {
    const { c } = mk({
      ttb_orders: [
        { id: "a", line: "main", sender: S, order_id: O1, state: "closed", size: "1GB", recipient: S, notices: [], created_at: "2026-11-13T10:00:00.000Z" },
        { id: "b", line: "main", sender: S, order_id: O2, state: "awaiting_payment", size: "5GB", recipient: "0200000150", notices: ["unpaid"], created_at: "2026-11-13T11:00:00.000Z" },
        { id: "c", line: "shop", sender: S, order_id: "x", state: "paid", size: "9GB", recipient: S, notices: [], created_at: "2026-11-13T11:30:00.000Z" },
      ],
    })
    expect(await latestOrderLink(c, "main", S)).toEqual({
      id: "b", orderId: O2, service: "data", orderTable: "ussd_orders", state: "awaiting_payment", size: "5GB", recipient: "0200000150", notices: ["unpaid"], createdAt: "2026-11-13T11:00:00.000Z",
    })
    expect(await latestOrderLink(c, "main", "0200000199")).toBeNull()
  })

  it("latestOrderLink throws TtbStoreError on a read error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_orders = { message: "down" }
    await expect(latestOrderLink(c, "main", S)).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("ussdOrderStatus reads the two status columns, null when the row is missing", async () => {
    const { c } = mk({ ussd_orders: [{ id: O1, order_status: "processing", payment_status: "paid" }] })
    expect(await ussdOrderStatus(c, O1)).toEqual({ orderStatus: "processing", paymentStatus: "paid" })
    expect(await ussdOrderStatus(c, O2)).toBeNull()
  })

})

describe("claimInbound", () => {
  const id = "m1"
  it("claims an unprocessed, unclaimed row once; a second claim inside the lease fails", async () => {
    const { db, c } = mk({ ttb_messages: [{ id, outcome: null, claimed_at: null }] })
    expect(await claimInbound(c, id, now)).toBe(true)
    expect(db.tables.ttb_messages[0].claimed_at).toBe(now.toISOString())
    expect(await claimInbound(c, id, new Date(now.getTime() + 30_000))).toBe(false)
  })

  it("claims again once the lease (default 60 s) has expired and the outcome is still null", async () => {
    const { c } = mk({ ttb_messages: [{ id, outcome: null, claimed_at: now.toISOString() }] })
    expect(await claimInbound(c, id, new Date(now.getTime() + 61_000))).toBe(true)
  })

  it("honours a custom lease", async () => {
    const { c } = mk({ ttb_messages: [{ id, outcome: null, claimed_at: now.toISOString() }] })
    expect(await claimInbound(c, id, new Date(now.getTime() + 20_000), 10)).toBe(true)
  })

  it("never claims a row that already has an outcome, or a missing row", async () => {
    const { c } = mk({ ttb_messages: [{ id, outcome: "prompted", claimed_at: null }] })
    expect(await claimInbound(c, id, now)).toBe(false)
    expect(await claimInbound(c, "nope", now)).toBe(false)
  })

  it("throws TtbStoreError on a database error", async () => {
    const { db, c } = mk()
    db.failOn.ttb_messages = { message: "down" }
    await expect(claimInbound(c, id, now)).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("notifier reads and writes", () => {
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString()
  const link = (o: Record<string, unknown>) => ({
    line: "main", sender: S, order_id: crypto.randomUUID(), state: "awaiting_payment", size: "1GB", recipient: S, gift: false,
    amount: 5, notices: [], created_at: iso(-60_000), paid_at: null, delivered_at: null, closed_at: null, ...o,
  })

  it("watchedLinks: non-closed oldest first, plus closed-in-48h unpaid-never; not older closed, not closed-and-paid", async () => {
    const { c } = mk({
      ttb_orders: [
        link({ id: "b", sender: "0200000102", created_at: iso(-30_000) }),
        link({ id: "a", state: "paid", paid_at: iso(-1000), created_at: iso(-90_000) }),
        link({ id: "closed-recent", state: "closed", closed_at: iso(-3_600_000), sender: "0200000103" }),
        link({ id: "closed-old", state: "closed", closed_at: iso(-49 * 3_600_000), sender: "0200000104" }),
        link({ id: "closed-paid", state: "closed", closed_at: iso(-3_600_000), paid_at: iso(-4_000_000), sender: "0200000105" }),
      ],
    })
    const rows = await watchedLinks(c, now, 200)
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "closed-recent"])
    expect(rows[0]).toMatchObject({ orderId: expect.any(String), state: "paid", gift: false, amount: 5, notices: [] })
  })

  it("watchedLinks caps the non-closed scan at the limit", async () => {
    const seed = Array.from({ length: 5 }, (_, i) => link({ id: `l${i}`, sender: `020000010${i}`, created_at: iso(-i * 1000) }))
    const { c } = mk({ ttb_orders: seed })
    expect(await watchedLinks(c, now, 3)).toHaveLength(3)
  })

  it("ussdOrderForNotify reads status, payment and amount as a number; null when gone", async () => {
    const { c } = mk({ ussd_orders: [{ id: "o1", order_status: "pending", payment_status: "pending", amount: "7.50" }] })
    expect(await ussdOrderForNotify(c, "o1")).toEqual({ orderStatus: "pending", paymentStatus: "pending", amount: 7.5 })
    expect(await ussdOrderForNotify(c, "nope")).toBeNull()
  })

  it("addNotice records a key once; a second call (an overlapping run) gets false and changes nothing", async () => {
    const { db, c } = mk({ ttb_orders: [link({ id: "x", notices: ["repriced"] })] })
    expect(await addNotice(c, "x", ["repriced"], "unpaid")).toBe(true)
    expect(db.tables.ttb_orders[0].notices).toEqual(["repriced", "unpaid"])
    expect(await addNotice(c, "x", ["repriced"], "unpaid")).toBe(false)
    expect(db.tables.ttb_orders[0].notices).toEqual(["repriced", "unpaid"])
  })

  it("addNotice goes through the ttb_add_notice RPC and throws TtbStoreError on error", async () => {
    const { db, c } = mk({ ttb_orders: [link({ id: "x" })] })
    expect(await addNotice(c, "x", [], "unpaid")).toBe(true)
    expect(db.rpcCalls).toEqual([{ name: "ttb_add_notice", args: { p_id: "x", p_key: "unpaid" } }])
    db.failOn.ttb_orders = { message: "down" }
    await expect(addNotice(c, "x", [], "delivered")).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("patchLink updates only a row still in one of the allowed states", async () => {
    const { db, c } = mk({ ttb_orders: [link({ id: "x" })] })
    expect(await patchLink(c, "x", { state: "paid", paid_at: now.toISOString() }, ["closed"])).toBe(false)
    expect(db.tables.ttb_orders[0].state).toBe("awaiting_payment")
    expect(await patchLink(c, "x", { state: "paid", paid_at: now.toISOString() }, ["awaiting_payment", "closed"])).toBe(true)
    expect(db.tables.ttb_orders[0]).toMatchObject({ state: "paid", paid_at: now.toISOString() })
  })

  it("strandedInbound: in, no outcome, 90 s to 15 min old, oldest first, capped", async () => {
    const m = (id: string, ageMs: number, extra: Record<string, unknown> = {}) =>
      ({ id, line: "main", sender: S, direction: "in", body: "1GB", received_at: null, outcome: null, created_at: iso(-ageMs), ...extra })
    const { c } = mk({
      ttb_messages: [
        m("fresh", 30_000), m("ok2", 5 * 60_000), m("ok1", 10 * 60_000), m("old", 16 * 60_000),
        m("done", 5 * 60_000, { outcome: "prompted" }), m("out", 5 * 60_000, { direction: "out" }),
      ],
    })
    expect((await strandedInbound(c, now, 20)).map((r) => r.id)).toEqual(["ok1", "ok2"])
    expect(await strandedInbound(c, now, 1)).toHaveLength(1)
  })

  it("getHeartbeat reads a line's last_seen_at, null when absent; touchHeartbeat accepts the bookkeeping lines", async () => {
    const { db, c } = mk()
    expect(await getHeartbeat(c, "main")).toBeNull()
    await touchHeartbeat(c, "purge", now)
    expect(db.tables.ttb_heartbeat).toEqual([{ line: "purge", last_seen_at: now.toISOString() }])
    expect((await getHeartbeat(c, "purge"))?.toISOString()).toBe(now.toISOString())
  })

  it("purgeOld calls ttb_purge with the cutoff and returns the count; throws TtbStoreError on error", async () => {
    const { db, c } = mk()
    db.rpcImpl = () => ({ data: 7, error: null })
    expect(await purgeOld(c, now)).toBe(7)
    expect(db.rpcCalls).toEqual([{ name: "ttb_purge", args: { p_before: now.toISOString() } }])
    db.rpcImpl = () => ({ data: null, error: { message: "boom" } })
    await expect(purgeOld(c, now)).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("Stage 2 plumbing: links carry the service and the order table", () => {
  const A = "6f0c1a9e-0163-4163-8163-0000000000d1"
  const base = { line: "main" as const, sender: S, orderId: A, size: "airtime 10", recipient: "0200000150", gift: false, amount: 10 }

  it("linkOrder writes service and order_table", async () => {
    const { db, c } = mk()
    await linkOrder(c, { ...base, service: "airtime", orderTable: "airtime_orders" })
    expect(db.tables.ttb_orders[0]).toMatchObject({ service: "airtime", order_table: "airtime_orders" })
  })

  it("linkOrder refuses a mismatched pair and writes nothing", async () => {
    const { db, c } = mk()
    await expect(linkOrder(c, { ...base, service: "airtime", orderTable: "ussd_orders" })).rejects.toBeInstanceOf(TtbStoreError)
    await expect(linkOrder(c, { ...base, service: "data", orderTable: "results_checker_orders" })).rejects.toBeInstanceOf(TtbStoreError)
    expect(db.tables.ttb_orders).toHaveLength(0)
  })

  it("ORDER_TABLE_OF names each service's order table", () => {
    expect(ORDER_TABLE_OF).toEqual({ data: "ussd_orders", airtime: "airtime_orders", results_checker: "results_checker_orders" })
  })

  it("orderRowFor reads airtime_orders status columns", async () => {
    const { c } = mk({ airtime_orders: [{ id: A, status: "pending", payment_status: "completed", total_paid: 10, airtime_amount: 9.52 }] })
    expect(await orderRowFor(c, "airtime_orders", A)).toEqual({ orderStatus: "pending", paymentStatus: "completed", amount: 10 })
    expect(await orderRowFor(c, "ussd_orders", A)).toBeNull()
  })

  it("orderRowFor reads results_checker_orders", async () => {
    const { c } = mk({ results_checker_orders: [{ id: A, status: "pending", payment_status: "completed", total_paid: "30.00" }] })
    expect(await orderRowFor(c, "results_checker_orders", A)).toEqual({ orderStatus: "pending", paymentStatus: "completed", amount: 30 })
    expect(await orderRowFor(c, "airtime_orders", A)).toBeNull()
  })

  it("orderRowFor reads ussd_orders and throws TtbStoreError on a read error", async () => {
    const { db, c } = mk({ ussd_orders: [{ id: A, order_status: "processing", payment_status: "paid", amount: "7.50" }] })
    expect(await orderRowFor(c, "ussd_orders", A)).toEqual({ orderStatus: "processing", paymentStatus: "paid", amount: 7.5 })
    db.failOn.ussd_orders = { message: "down" }
    await expect(orderRowFor(c, "ussd_orders", A)).rejects.toBeInstanceOf(TtbStoreError)
  })

  it("latestOrderLink and watchedLinks carry service and orderTable as raw strings", async () => {
    const row = { id: "L1", line: "main", sender: S, order_id: A, state: "awaiting_payment", size: "airtime 10", recipient: S, gift: false, amount: 10, notices: [], created_at: "2026-11-13T11:00:00.000Z", paid_at: null, closed_at: null, delivered_at: null }
    const { c } = mk({ ttb_orders: [{ ...row, service: "airtime", order_table: "airtime_orders" }] })
    expect(await latestOrderLink(c, "main", S)).toMatchObject({ service: "airtime", orderTable: "airtime_orders" })
    expect((await watchedLinks(c, now, 10))[0]).toMatchObject({ service: "airtime", orderTable: "airtime_orders" })
    const odd = mk({ ttb_orders: [{ ...row, service: "mystery", order_table: "mystery_orders" }] })
    expect(await latestOrderLink(odd.c, "main", S)).toMatchObject({ service: "mystery", orderTable: "mystery_orders" })
    expect((await watchedLinks(odd.c, now, 10))[0]).toMatchObject({ service: "mystery", orderTable: "mystery_orders" })
  })

  it("a link row with null service or order_table maps to data / ussd_orders", async () => {
    const row = { id: "L1", line: "main", sender: S, order_id: A, state: "awaiting_payment", size: "1GB", recipient: S, gift: false, amount: 5, notices: [], created_at: "2026-11-13T11:00:00.000Z", paid_at: null, closed_at: null, delivered_at: null, service: null, order_table: null }
    const { c } = mk({ ttb_orders: [row] })
    expect(await latestOrderLink(c, "main", S)).toMatchObject({ service: "data", orderTable: "ussd_orders" })
    expect((await watchedLinks(c, now, 10))[0]).toMatchObject({ service: "data", orderTable: "ussd_orders" })
  })
})
