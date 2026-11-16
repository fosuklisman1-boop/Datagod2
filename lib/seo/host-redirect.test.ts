import { describe, it, expect } from "vitest"
import { legacyHostRedirect } from "./host-redirect"

const ROOT = "datagod.store"

describe("legacyHostRedirect", () => {
  it.each(["app.datagod.store", "admin.datagod.store", "APP.datagod.store:443"])("sends %s to www, keeping the path", (host) => {
    expect(legacyHostRedirect(host, "/mtn-data", ROOT)).toBe("https://www.datagod.store/mtn-data")
    expect(legacyHostRedirect(host, "/", ROOT)).toBe("https://www.datagod.store/")
  })

  it.each(["www.datagod.store", "datagod.store", "api.datagod.store", "kofi.datagod.store", "app.example.com", "localhost:3000", null])(
    "leaves %s alone",
    (host) => {
      expect(legacyHostRedirect(host, "/mtn-data", ROOT)).toBeNull()
    },
  )

  it("leaves API paths and the OAuth callback alone", () => {
    expect(legacyHostRedirect("app.datagod.store", "/api/v2/balance", ROOT)).toBeNull()
    expect(legacyHostRedirect("app.datagod.store", "/auth/callback", ROOT)).toBeNull()
    expect(legacyHostRedirect("admin.datagod.store", "/auth/callback/x", ROOT)).toBeNull()
  })

  it("does not treat a nested label as app./admin.", () => {
    expect(legacyHostRedirect("x.app.datagod.store", "/", ROOT)).toBeNull()
  })
})
