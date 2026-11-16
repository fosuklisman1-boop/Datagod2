import { describe, it, expect } from "vitest"
import {
  parseListParams,
  validateUpdateBody,
  validateRecheckBody,
  supplierRows,
  aggregateAttempts,
  MAX_RECHECK_IDS,
  MAX_NOTE,
} from "./admin-view"

const UUID = "123e4567-e89b-12d3-a456-426614174000"

describe("parseListParams", () => {
  it("defaults", () => {
    const p = parseListParams(new URLSearchParams())
    expect(p).toMatchObject({ page: 1, status: null, surface: null, shopId: null, q: null })
  })

  it("rejects unknown status and surface values (ignored, not passed to the query)", () => {
    const p = parseListParams(new URLSearchParams("status=hax&surface=nope&shop=not-a-uuid&page=-4"))
    expect(p.status).toBeNull()
    expect(p.surface).toBeNull()
    expect(p.shopId).toBeNull()
    expect(p.page).toBe(1)
  })

  it("accepts valid filters", () => {
    const p = parseListParams(new URLSearchParams(`status=blocked&surface=storefront&shop=${UUID}&page=3&q=024`))
    expect(p).toMatchObject({ status: "blocked", surface: "storefront", shopId: UUID, page: 3, q: "024" })
  })

  it("strips characters that could break a PostgREST filter from the search text", () => {
    const p = parseListParams(new URLSearchParams("q=" + encodeURIComponent("a,b(c)%_*")))
    expect(p.q).toBe("abc")
  })
})

describe("validateUpdateBody", () => {
  it("handle requires a non-empty note", () => {
    expect(validateUpdateBody({ id: UUID, action: "handle" }).ok).toBe(false)
    expect(validateUpdateBody({ id: UUID, action: "handle", note: "   " }).ok).toBe(false)
  })

  it("handle note is capped at 500 chars", () => {
    expect(MAX_NOTE).toBe(500)
    expect(validateUpdateBody({ id: UUID, action: "handle", note: "x".repeat(500) }).ok).toBe(true)
    expect(validateUpdateBody({ id: UUID, action: "handle", note: "x".repeat(501) }).ok).toBe(false)
  })

  it("reopen needs no note; bad id or action rejected", () => {
    expect(validateUpdateBody({ id: UUID, action: "reopen" }).ok).toBe(true)
    expect(validateUpdateBody({ id: "x", action: "reopen" }).ok).toBe(false)
    expect(validateUpdateBody({ id: UUID, action: "delete" }).ok).toBe(false)
    expect(validateUpdateBody(null).ok).toBe(false)
  })
})

describe("validateRecheckBody", () => {
  it("accepts ids and all:true", () => {
    expect(validateRecheckBody({ ids: [UUID] }).ok).toBe(true)
    expect(validateRecheckBody({ all: true }).ok).toBe(true)
  })

  it("rejects more than 500 ids", () => {
    expect(MAX_RECHECK_IDS).toBe(500)
    const ids = Array.from({ length: 501 }, () => UUID)
    expect(validateRecheckBody({ ids }).ok).toBe(false)
    expect(validateRecheckBody({ ids: ids.slice(0, 500) }).ok).toBe(true)
  })

  it("rejects empty, non-uuid and missing", () => {
    expect(validateRecheckBody({ ids: [] }).ok).toBe(false)
    expect(validateRecheckBody({ ids: ["x"] }).ok).toBe(false)
    expect(validateRecheckBody({}).ok).toBe(false)
    expect(validateRecheckBody(null).ok).toBe(false)
  })
})

describe("supplierRows", () => {
  it("returns a single Phone column in 0XXXXXXXXX form, skipping bad values", () => {
    expect(supplierRows(["0241234567", "233241234568", "bad", "0241234567"])).toEqual([
      { Phone: "0241234567" },
      { Phone: "0241234568" },
    ])
  })
})

describe("aggregateAttempts", () => {
  it("groups distinct surfaces and shop ids per number", () => {
    const m = aggregateAttempts([
      { blocked_number_id: "a", surface: "storefront", shop_id: "s1" },
      { blocked_number_id: "a", surface: "storefront", shop_id: "s2" },
      { blocked_number_id: "a", surface: "api_v1", shop_id: null },
      { blocked_number_id: "b", surface: "ussd_uzo", shop_id: null },
    ])
    expect(m.get("a")).toEqual({ surfaces: ["storefront", "api_v1"], shopIds: ["s1", "s2"] })
    expect(m.get("b")).toEqual({ surfaces: ["ussd_uzo"], shopIds: [] })
  })
})
