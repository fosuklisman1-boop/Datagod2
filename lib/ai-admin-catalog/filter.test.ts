import { describe, expect, it } from "vitest"
import { filterLookupResult, isHiddenKey, MAX_LOOKUP_BYTES } from "./filter"
import type { CatalogEntry } from "./types"

function entry(resultKeep?: string[]): CatalogEntry {
  return {
    id: "x.y",
    area: "x",
    page: "/p",
    pageTitle: "P",
    summary: "s",
    method: "GET",
    path: "/api/x",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep,
  }
}

describe("filterLookupResult", () => {
  it("keeps only resultKeep paths including array element paths", () => {
    const body = {
      total: 2,
      extra: 1,
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
      user: { id: "u", email: "e" },
    }
    const r = filterLookupResult(entry(["total", "items[].id", "user.id"]), body)
    expect(r).toEqual({ data: { total: 2, items: [{ id: 1 }, { id: 2 }], user: { id: "u" } }, truncated: false })
  })

  it("returns the whole body when resultKeep is missing", () => {
    expect(filterLookupResult(entry(), { a: 1 }).data).toEqual({ a: 1 })
  })

  it("hides secret-named keys at any depth but keeps token_count", () => {
    const body = {
      password: "p",
      nested: [{ deepseek_api_key: "k", webhook_secret: "w", token_count: 5, Access_Token: "t" }],
    }
    const r = filterLookupResult(entry(), body)
    expect(r.data).toEqual({
      password: "[hidden]",
      nested: [{ deepseek_api_key: "[hidden]", webhook_secret: "[hidden]", token_count: 5, Access_Token: "[hidden]" }],
    })
  })

  it("hides even when a resultKeep path selects a secret key", () => {
    const r = filterLookupResult(entry(["cfg.service_role_key", "cfg.name"]), {
      cfg: { service_role_key: "z", name: "n" },
    })
    expect(r.data).toEqual({ cfg: { service_role_key: "[hidden]", name: "n" } })
  })

  it("truncates a 2 MB array to valid JSON within the limit", () => {
    const items = Array.from({ length: 20000 }, (_, i) => ({ id: i, pad: "x".repeat(100) }))
    const r = filterLookupResult(entry(), { items })
    expect(r.truncated).toBe(true)
    const s = JSON.stringify(r.data)
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(MAX_LOOKUP_BYTES)
    expect(JSON.parse(s)).toBeTruthy()
  })

  it("returns null when it cannot fit", () => {
    const r = filterLookupResult(entry(), { blob: "x".repeat(20000) })
    expect(r).toEqual({ data: null, truncated: true })
  })

  it("does not flag small results", () => {
    expect(filterLookupResult(entry(), [1, 2]).truncated).toBe(false)
  })
})

describe("isHiddenKey", () => {
  it.each([
    "password",
    "secret",
    "api_key",
    "x_api_key",
    "my_secret",
    "access_token",
    "refresh_token",
    "service_role_key",
    "webhook_secret",
    "PASSWORD",
  ])("hides %s", (k) => expect(isHiddenKey(k)).toBe(true))
  it.each(["token_count", "secrets_count", "keyboard", "name"])("keeps %s", (k) =>
    expect(isHiddenKey(k)).toBe(false),
  )
})
