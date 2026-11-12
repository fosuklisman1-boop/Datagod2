import { describe, it, expect } from "vitest"
import {
  EXPORT_CHUNK_SIZE,
  decodeExportCursor,
  encodeExportCursor,
  parseExportParams,
  toExportRpcArgs,
} from "./export-params"

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

describe("export cursor", () => {
  it("round-trips, keeping microseconds and -infinity exactly", () => {
    for (const createdAt of ["2026-01-01T10:00:00.123456+00:00", "2026-01-01T10:00:00+00:00", "-infinity"]) {
      const c = { createdAt, id: ID }
      const s = encodeExportCursor(c)
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeExportCursor(s)).toEqual(c)
    }
  })

  it("rejects anything that is not a cursor we made", () => {
    expect(decodeExportCursor("")).toBeNull()
    expect(decodeExportCursor("not base64 !!")).toBeNull()
    expect(decodeExportCursor(Buffer.from("{}").toString("base64url"))).toBeNull()
    expect(decodeExportCursor(Buffer.from(JSON.stringify(["2026-01-01T10:00:00+00:00", "x"])).toString("base64url"))).toBeNull()
    expect(decodeExportCursor(Buffer.from(JSON.stringify(["yesterday", ID])).toString("base64url"))).toBeNull()
    expect(decodeExportCursor(Buffer.from(JSON.stringify(["2026-01-01T10:00:00+00:00'; drop", ID])).toString("base64url"))).toBeNull()
  })
})

describe("parseExportParams", () => {
  const parse = (qs: string) => parseExportParams(new URLSearchParams(qs))

  it("uses the list filters, ignores sort/page, defaults to the full chunk", () => {
    const r = parse("role=dealer&q=ama&sort=email&dir=asc&page=9&pageSize=3")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.filters).toMatchObject({ role: "dealer", q: "ama" })
    expect(r.cursor).toBeNull()
    expect(r.limit).toBe(EXPORT_CHUNK_SIZE)
  })

  it("decodes the cursor and clamps limit to 1..5000", () => {
    const cursor = encodeExportCursor({ createdAt: "2026-01-01T10:00:00+00:00", id: ID })
    const r = parse(`cursor=${cursor}&limit=999999`)
    expect(r).toMatchObject({ ok: true, cursor: { createdAt: "2026-01-01T10:00:00+00:00", id: ID }, limit: 5000 })
    expect(parse("limit=0")).toMatchObject({ ok: true, limit: 1 })
  })

  it("400s on a bad cursor, limit or filter", () => {
    expect(parse("cursor=garbage")).toEqual({ ok: false, errors: ["cursor is invalid"] })
    expect(parse("limit=lots")).toEqual({ ok: false, errors: ["limit must be an integer from 1 to 5000"] })
    expect(parse("role=root").ok).toBe(false)
  })

  it("swaps a reversed date range like the page does", () => {
    const r = parse("from=2026-05-01&to=2026-04-01")
    expect(r).toMatchObject({ ok: true, filters: { from: "2026-04-01", to: "2026-05-01" } })
  })
})

describe("toExportRpcArgs", () => {
  it("maps filters, cursor and limit", () => {
    const r = parseExportParams(new URLSearchParams("q=%20ama%20&suspended=false&from=2026-01-01&to=2026-01-31"))
    if (!r.ok) throw new Error("bad")
    expect(toExportRpcArgs(r.filters, { createdAt: "-infinity", id: ID }, 2000)).toEqual({
      p_search: "ama", p_role: null, p_suspended: false, p_has_shop: null, p_pricing_mode: null,
      p_created_from: "2026-01-01T00:00:00Z", p_created_to: "2026-02-01T00:00:00Z",
      p_after_created_at: "-infinity", p_after_id: ID, p_limit: 2000, p_tag: null,
    })
    const t = parseExportParams(new URLSearchParams("tag=VIP"))
    if (!t.ok) throw new Error("bad")
    expect(toExportRpcArgs(t.filters, null, 10).p_tag).toBe("vip")
    expect(toExportRpcArgs(r.filters, null, 5000)).toMatchObject({ p_after_created_at: null, p_after_id: null })
  })
})
