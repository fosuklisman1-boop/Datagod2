import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ value: undefined as unknown, fail: false }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { if (h.fail) throw new Error("db down"); return { data: h.value === undefined ? null : { value: h.value }, error: null } } }) }) }),
  }),
}))

import * as route from "./route"
import { resetAIConfigCache } from "@/lib/ai-console/load-config"

const ALL_ON = { admins: true, signedIn: true, shopVisitors: true, publicVisitors: true }
beforeEach(() => { resetAIConfigCache(); h.value = undefined; h.fail = false })

describe("assistant-profile route", () => {
  it("assistant_profile_returns_default_name_cached", async () => {
    const res = await route.GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "DATAGOD AI", audiences: ALL_ON })
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60")
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic"])
    expect(route.dynamic).toBe("force-dynamic")
  })

  it("profile_returns_audiences", async () => {
    h.value = { assistant_name: "Kofi Bot", tone: "fun", max_tool_steps: 5, anthropic_api_key: "sk-secret", audiences: { admins: true, signedIn: true, shopVisitors: false, publicVisitors: true } }
    const body = await (await route.GET()).json()
    expect(body).toEqual({ name: "Kofi Bot", audiences: { admins: true, signedIn: true, shopVisitors: false, publicVisitors: true } })
  })

  it("read error falls back to defaults", async () => {
    h.fail = true
    expect(await (await route.GET()).json()).toEqual({ name: "DATAGOD AI", audiences: ALL_ON })
  })
})
