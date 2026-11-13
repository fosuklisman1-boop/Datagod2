import { describe, it, expect, vi, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import {
  dedupeKey, storeInbound, setInboundResult, storeOutbound, isBlocked, counts, globalPrompts, hasOpenOrder, linkOrder,
  loadConversation, saveConversation, touchHeartbeat, TtbStoreError,
} from "./store"

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

describe("hasOpenOrder / linkOrder", () => {
  const o = { line: "main" as const, sender: S, orderId: "6f0c1a9e-0163-4163-8163-0000000000a1", size: "1GB", recipient: "0200000150", gift: false, amount: 5 }

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
