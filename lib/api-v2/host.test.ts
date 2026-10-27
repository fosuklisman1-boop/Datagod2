import { describe, expect, it } from "vitest"
import { apiHostRewrite } from "./host"

const ROOT = "datagod.store"

describe("apiHostRewrite", () => {
  it("rewrites /v2/* on the api host to /api/v2/*", () => {
    expect(apiHostRewrite("api.datagod.store", "/v2/data/purchase", ROOT)).toBe("/api/v2/data/purchase")
    expect(apiHostRewrite("api.datagod.store", "/v2/sms/campaigns/12", ROOT)).toBe("/api/v2/sms/campaigns/12")
    expect(apiHostRewrite("api.datagod.store", "/v2", ROOT)).toBe("/api/v2")
  })

  it("is case-insensitive on the host and ignores a port", () => {
    expect(apiHostRewrite("API.Datagod.Store:443", "/v2/packages", ROOT)).toBe("/api/v2/packages")
  })

  it("does not touch other hosts", () => {
    for (const h of ["www.datagod.store", "datagod.store", "my-shop.datagod.store", "localhost:3000", "evil-api.datagod.store", "api.datagod.store.evil.com", null, ""]) {
      expect(apiHostRewrite(h, "/v2/packages", ROOT)).toBeNull()
    }
  })

  it("does not touch other paths on the api host", () => {
    for (const p of ["/", "/v1/orders", "/v20/x", "/v2x", "/api/v2/packages", "/robots.txt", "/_next/static/a.js"]) {
      expect(apiHostRewrite("api.datagod.store", p, ROOT)).toBeNull()
    }
  })
})
