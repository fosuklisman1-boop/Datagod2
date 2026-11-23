import { describe, expect, it } from "vitest"
import { z } from "zod"
import { resolveRequest, sameRequest } from "./resolve"
import type { CatalogEntry } from "./types"

const UUID = "123e4567-e89b-12d3-a456-426614174000"

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "x.y",
    area: "x",
    page: "/admin/x",
    pageTitle: "X",
    summary: "s",
    method: "POST",
    path: "/api/admin/users/:id",
    params: { id: "uuid" },
    body: z.object({ note: z.string() }).strict(),
    query: z.object({ page: z.number().optional(), q: z.string().optional() }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    ...over,
  }
}

describe("resolveRequest", () => {
  it("substitutes and encodes a uuid param", () => {
    const r = resolveRequest(entry(), { params: { id: UUID }, body: { note: "hi" } })
    expect(r).toEqual({
      ok: true,
      req: { method: "POST", path: `/api/admin/users/${UUID}`, query: "", body: { note: "hi" } },
    })
  })

  it.each(["../users", "abc?role=admin", "", "a/b"])("rejects bad uuid %j", (v) => {
    const r = resolveRequest(entry(), { params: { id: v }, body: { note: "hi" } })
    expect(r).toMatchObject({ ok: false, code: "bad_param" })
  })

  it("rejects a missing param", () => {
    expect(resolveRequest(entry(), { body: { note: "hi" } })).toMatchObject({ ok: false, code: "bad_param" })
  })

  it("accepts a slug and rejects a 65-char slug", () => {
    const e = entry({ path: "/api/admin/shops/:slug", params: { slug: "slug" } })
    expect(resolveRequest(e, { params: { slug: "my-shop_1" }, body: { note: "a" } })).toMatchObject({ ok: true })
    expect(resolveRequest(e, { params: { slug: "a".repeat(64) }, body: { note: "a" } })).toMatchObject({ ok: true })
    expect(resolveRequest(e, { params: { slug: "a".repeat(65) }, body: { note: "a" } })).toMatchObject({
      ok: false,
      code: "bad_param",
    })
    expect(resolveRequest(e, { params: { slug: "../x" }, body: { note: "a" } })).toMatchObject({
      ok: false,
      code: "bad_param",
    })
  })

  it("rejects an unknown body key", () => {
    const r = resolveRequest(entry(), { params: { id: UUID }, body: { note: "hi", role: "admin" } })
    expect(r).toMatchObject({ ok: false, code: "bad_input" })
  })

  it("rejects a secret field in the body before schema validation", () => {
    const e = entry({
      body: z.object({ password: z.string() }).strict(),
      secretFields: [{ name: "password", label: "Password", min: 8, max: 64 }],
    })
    const r = resolveRequest(e, { params: { id: UUID }, body: { password: "hunter2hunter2" } })
    expect(r).toMatchObject({ ok: false, code: "secret_in_input" })
    if (!r.ok) expect(r.message).not.toContain("hunter2")
  })

  it("serializes query keys sorted", () => {
    const e = entry({ method: "GET", path: "/api/admin/list", params: undefined, body: undefined })
    const r = resolveRequest(e, { query: { q: "a b", page: 2 } })
    expect(r).toEqual({
      ok: true,
      req: { method: "GET", path: "/api/admin/list", query: "page=2&q=a+b", body: null },
    })
  })

  it("rejects bad query", () => {
    const e = entry({ method: "GET", path: "/api/admin/list", params: undefined, body: undefined })
    expect(resolveRequest(e, { query: { evil: "1" } })).toMatchObject({ ok: false, code: "bad_input" })
  })

  it("rejects a body when the entry has no body schema, and requires one when it does", () => {
    const e = entry({ params: undefined, path: "/api/admin/p", body: undefined })
    expect(resolveRequest(e, { body: { a: 1 } })).toMatchObject({ ok: false, code: "bad_input" })
    expect(resolveRequest(entry(), { params: { id: UUID } })).toMatchObject({ ok: false, code: "bad_input" })
  })
})

describe("sameRequest", () => {
  const base = { method: "POST", path: "/a", query: "x=1", body: { a: 1, b: { c: 2, d: 3 } } } as const
  it("is true for equal requests regardless of body key order", () => {
    expect(sameRequest(base, { ...base, body: { b: { d: 3, c: 2 }, a: 1 } })).toBe(true)
  })
  it("is false when method, path, query or body differ", () => {
    expect(sameRequest(base, { ...base, method: "PUT" })).toBe(false)
    expect(sameRequest(base, { ...base, path: "/b" })).toBe(false)
    expect(sameRequest(base, { ...base, query: "x=2" })).toBe(false)
    expect(sameRequest(base, { ...base, body: { a: 1 } })).toBe(false)
    expect(sameRequest(base, { ...base, body: null })).toBe(false)
  })
})
