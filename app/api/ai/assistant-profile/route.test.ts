import { describe, it, expect } from "vitest"
import * as route from "./route"

describe("assistant-profile route", () => {
  it("assistant_profile_returns_default_name_cached", async () => {
    const res = await route.GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "DATAGOD AI" })
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60")
    expect(Object.keys(route)).toEqual(["GET"])
  })
})
