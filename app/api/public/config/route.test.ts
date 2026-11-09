import { describe, it, expect, vi, beforeEach } from "vitest"

// Fake supabaseAdmin: app_settings queries are distinguished by their select() column list.
let openJoinResult: { data: unknown; error: unknown } | "throw"
const mainAppData = { ussd_shop_dial_code: "*123#", ussd_shop_activation_fee: 5 }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (cols: string) => {
        if (table === "admin_settings") {
          return { or: async () => ({ data: [{ key: "airtime_x", value: "1" }], error: null }) }
        }
        const isFlag = cols === "sub_agent_open_join_enabled"
        return {
          is: () => ({
            maybeSingle: async () => {
              if (!isFlag) return { data: mainAppData, error: null }
              if (openJoinResult === "throw") throw new Error("boom")
              return openJoinResult
            },
          }),
        }
      },
    }),
  },
}))

import { GET } from "./route"

describe("GET /api/public/config sub_agent_open_join_enabled", () => {
  beforeEach(() => {
    openJoinResult = { data: { sub_agent_open_join_enabled: true }, error: null }
  })

  it("exposes the flag when the column exists", async () => {
    const body = await (await GET()).json()
    expect(body.app_settings.sub_agent_open_join_enabled).toBe(true)
    expect(body.app_settings.ussd_shop_dial_code).toBe("*123#")
  })

  it("falls back to false and keeps every other setting when the column is missing (error)", async () => {
    openJoinResult = { data: null, error: { message: "column does not exist" } }
    const body = await (await GET()).json()
    expect(body.app_settings.sub_agent_open_join_enabled).toBe(false)
    expect(body.app_settings.ussd_shop_dial_code).toBe("*123#")
    expect(body.app_settings.ussd_shop_activation_fee).toBe(5)
    expect(body.admin_settings.airtime_x).toBe("1")
  })

  it("falls back to false when the flag query throws", async () => {
    openJoinResult = "throw"
    const body = await (await GET()).json()
    expect(body.app_settings.sub_agent_open_join_enabled).toBe(false)
    expect(body.app_settings.ussd_shop_dial_code).toBe("*123#")
  })
})
