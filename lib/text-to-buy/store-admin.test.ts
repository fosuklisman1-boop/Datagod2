import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import { blockSender, unblockSender, markMisread, listInbound, listThread, overviewRows, serviceCountsToday, saveSettingRows, TtbStoreError } from "./store"
import { decodeCursor } from "./admin-view"

const mk = (seed: Record<string, Record<string, unknown>[]> = {}) => {
  const f = makeFakeTtb(seed)
  return { db: f.db, c: f.client as unknown as SupabaseClient }
}
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const msg = (n: number, at: string, extra: Record<string, unknown> = {}) => ({
  id: id(n), line: "main", sender: "0200000101", direction: "in", body: `m${n}`, created_at: at, misread: false, ...extra,
})

describe("blockSender / unblockSender", () => {
  it("blocks with the admin id and reason, re-blocking updates instead of failing, unblock deletes", async () => {
    const { db, c } = mk()
    await blockSender(c, "0200000101", "spam", ADMIN)
    expect(db.tables.ttb_blocked).toEqual([{ sender: "0200000101", reason: "spam", blocked_by: ADMIN }])
    await blockSender(c, "0200000101", null, ADMIN)
    expect(db.tables.ttb_blocked).toHaveLength(1)
    expect(db.tables.ttb_blocked[0].reason).toBeNull()
    expect(await unblockSender(c, "0200000101")).toBe(true)
    expect(db.tables.ttb_blocked).toEqual([])
    expect(await unblockSender(c, "0200000101")).toBe(false)
  })
  it("fails with a fixed TtbStoreError and no database text", async () => {
    const { db, c } = mk()
    db.failOn.ttb_blocked = { message: "row 0200000101 leaked" }
    const e = await blockSender(c, "0200000101", null, ADMIN).catch((x) => x)
    expect(e).toBeInstanceOf(TtbStoreError)
    expect(String(e.message)).not.toContain("0200000101")
    await expect(unblockSender(c, "0200000101")).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("markMisread", () => {
  it("flags an inbound row only", async () => {
    const { db, c } = mk({ ttb_messages: [msg(1, "2026-11-13T10:00:00Z"), msg(2, "2026-11-13T10:01:00Z", { direction: "out" })] })
    expect(await markMisread(c, id(1))).toBe(true)
    expect(db.tables.ttb_messages[0].misread).toBe(true)
    expect(await markMisread(c, id(2))).toBe(false)
    expect(db.tables.ttb_messages[1].misread).toBe(false)
    expect(await markMisread(c, id(3))).toBe(false)
  })
})

describe("listInbound", () => {
  const seed = () => ({
    ttb_messages: [
      msg(1, "2026-11-13T10:00:00Z", { outcome: "prompted", read_by: "rules" }),
      msg(2, "2026-11-13T10:01:00Z", { outcome: "not_order", read_by: "ai", sender: "0200000102" }),
      msg(3, "2026-11-13T10:02:00Z", { direction: "out" }),
      msg(4, "2026-11-13T10:03:00Z", { line: "shop" }),
    ],
  })
  it("returns inbound rows newest first, mapped, never outbound", async () => {
    const { c } = mk(seed())
    const r = await listInbound(c, { limit: 50 })
    expect(r.rows.map((x) => x.id)).toEqual([id(4), id(2), id(1)])
    expect(r.nextCursor).toBeNull()
    expect(r.rows[2]).toEqual({
      id: id(1), createdAt: "2026-11-13T10:00:00Z", line: "main", sender: "0200000101", direction: "in", body: "m1",
      readBy: "rules", outcome: "prompted", orderLinkId: null, misread: false,
    })
  })
  it("filters by line, sender and outcome", async () => {
    const { c } = mk(seed())
    expect((await listInbound(c, { limit: 50, line: "shop" })).rows.map((x) => x.id)).toEqual([id(4)])
    expect((await listInbound(c, { limit: 50, sender: "0200000102" })).rows.map((x) => x.id)).toEqual([id(2)])
    expect((await listInbound(c, { limit: 50, outcome: "prompted" })).rows.map((x) => x.id)).toEqual([id(1)])
  })
  it("pages with a keyset cursor: two rows with the same created_at appear exactly once across pages", async () => {
    const same = "2026-11-13T10:05:00.123456Z"
    const rows = [
      msg(1, "2026-11-13T10:00:00Z"), msg(2, same), msg(3, same), msg(4, same), msg(5, "2026-11-13T10:09:00Z"), msg(6, "2026-11-13T10:04:00Z"),
    ]
    const { c } = mk({ ttb_messages: rows })
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const r: Awaited<ReturnType<typeof listInbound>> = await listInbound(c, { limit: 2, cursor: cursor ? decodeCursor(cursor)! : undefined })
      seen.push(...r.rows.map((x) => x.id))
      cursor = r.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(seen).toEqual([id(5), id(4), id(3), id(2), id(6), id(1)])
    expect(new Set(seen).size).toBe(6)
    expect(pages).toBe(3)
  })
  it("a full last page has no nextCursor", async () => {
    const { c } = mk({ ttb_messages: [msg(1, "2026-11-13T10:00:00Z"), msg(2, "2026-11-13T10:01:00Z")] })
    expect((await listInbound(c, { limit: 2 })).nextCursor).toBeNull()
  })
  it("a database error is a fixed TtbStoreError", async () => {
    const { db, c } = mk()
    db.failOn.ttb_messages = { message: "boom 0200000101" }
    await expect(listInbound(c, { limit: 5 })).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("listThread", () => {
  it("returns both directions for the sender, oldest first, and the latest 200 when there are more", async () => {
    const many = Array.from({ length: 205 }, (_, i) => msg(i + 1, new Date(Date.UTC(2026, 10, 13, 8, 0, i)).toISOString(), { direction: i % 2 ? "out" : "in" }))
    const { c } = mk({ ttb_messages: [...many, msg(999, "2026-11-13T07:00:00Z", { sender: "0200000199" })] })
    const t = await listThread(c, "0200000101")
    expect(t).toHaveLength(200)
    expect(t[0].id).toBe(id(6))
    expect(t[199].id).toBe(id(205))
    expect(t.some((x) => x.sender !== "0200000101")).toBe(false)
    expect(t.some((x) => x.direction === "out")).toBe(true)
  })
  it("can be limited to one line", async () => {
    const { c } = mk({ ttb_messages: [msg(1, "2026-11-13T10:00:00Z"), msg(2, "2026-11-13T10:01:00Z", { line: "shop" })] })
    expect((await listThread(c, "0200000101", "shop")).map((x) => x.id)).toEqual([id(2)])
  })
})

describe("overviewRows", () => {
  it("calls ttb_overview with p_from and maps both lines", async () => {
    const { db, c } = mk()
    db.rpcImpl = () => ({
      data: [
        { line: "main", texts: 5, prompts: 3, paid: 2, delivered: 1, replies: 7, ai_reads: 2, rule_reads: 3 },
        { line: "shop", texts: 0, prompts: 0, paid: 0, delivered: 0, replies: 0, ai_reads: 0, rule_reads: 0 },
      ],
      error: null,
    })
    const rows = await overviewRows(c, new Date("2026-11-13T00:00:00Z"))
    expect(db.rpcCalls).toEqual([{ name: "ttb_overview", args: { p_from: "2026-11-13T00:00:00.000Z" } }])
    expect(rows[0]).toEqual({ line: "main", texts: 5, prompts: 3, paid: 2, delivered: 1, replies: 7, aiReads: 2, ruleReads: 3 })
    expect(rows).toHaveLength(2)
  })
  it("errors are a fixed TtbStoreError", async () => {
    const { db, c } = mk()
    db.rpcImpl = () => ({ data: null, error: { message: "x" } })
    await expect(overviewRows(c, new Date())).rejects.toBeInstanceOf(TtbStoreError)
  })
})

describe("serviceCountsToday", () => {
  const link = (n: number, service: string, extra: Record<string, unknown> = {}) => ({
    id: id(n), line: "main", sender: "0200000101", service, order_id: id(n + 500), created_at: "2026-11-13T09:00:00.000Z", paid_at: null, delivered_at: null, ...extra,
  })
  it("counts prompts, paid and delivered per service, main line only, since the start of today", async () => {
    const { db, c } = mk({
      ttb_orders: [
        link(1, "data", { paid_at: "2026-11-13T09:01:00Z", delivered_at: "2026-11-13T09:02:00Z" }),
        link(2, "data"),
        link(3, "airtime", { paid_at: "2026-11-13T09:01:00Z" }),
        link(4, "results_checker"),
        link(5, "results_checker", { paid_at: "2026-11-13T09:01:00Z", delivered_at: "2026-11-13T09:02:00Z" }),
        link(6, "data", { line: "shop", paid_at: "2026-11-13T09:01:00Z" }),
        link(7, "airtime", { created_at: "2026-11-12T23:59:00.000Z", paid_at: "2026-11-13T00:01:00Z" }),
      ],
    })
    const out = await serviceCountsToday(c, new Date("2026-11-13T00:00:00Z"))
    expect(out).toEqual({
      data: { prompts: 2, paid: 1, delivered: 1 },
      airtime: { prompts: 1, paid: 1, delivered: 0 },
      results_checker: { prompts: 2, paid: 1, delivered: 1 },
    })
    expect(db.rpcCalls).toEqual([])
  })
  it("an empty table gives zeros for every service", async () => {
    const { c } = mk()
    expect(await serviceCountsToday(c, new Date())).toEqual({
      data: { prompts: 0, paid: 0, delivered: 0 },
      airtime: { prompts: 0, paid: 0, delivered: 0 },
      results_checker: { prompts: 0, paid: 0, delivered: 0 },
    })
  })
  it("a failed read is a fixed TtbStoreError", async () => {
    const { db, c } = mk()
    db.failOn.ttb_orders = { message: "leak 0200000101" }
    const e = await serviceCountsToday(c, new Date()).catch((x) => x)
    expect(e).toBeInstanceOf(TtbStoreError)
    expect(String(e.message)).not.toContain("0200000101")
  })
})

describe("saveSettingRows", () => {
  it("upserts each key as { value } with the admin id, in one call, and does nothing for an empty set", async () => {
    const { db, c } = mk()
    await saveSettingRows(c, {}, ADMIN, new Date("2026-11-13T12:00:00Z"))
    expect(db.tables.admin_settings).toEqual([])
    await saveSettingRows(c, { ttb_stale_minutes: 15, ttb_main_enabled: true }, ADMIN, new Date("2026-11-13T12:00:00Z"))
    expect(db.tables.admin_settings).toEqual([
      { key: "ttb_stale_minutes", value: { value: 15 }, updated_by: ADMIN, updated_at: "2026-11-13T12:00:00.000Z" },
      { key: "ttb_main_enabled", value: { value: true }, updated_by: ADMIN, updated_at: "2026-11-13T12:00:00.000Z" },
    ])
  })
  it("a failure is a fixed TtbStoreError", async () => {
    const { db, c } = mk()
    db.failOn.admin_settings = { message: "x" }
    await expect(saveSettingRows(c, { ttb_stale_minutes: 15 }, ADMIN, new Date())).rejects.toBeInstanceOf(TtbStoreError)
  })
})
