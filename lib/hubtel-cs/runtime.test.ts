import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({}), rpc: async () => ({ data: null, error: null }) }),
}))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ checkTransactionStatus: vi.fn(), fetchDisbursementBalance: vi.fn() }))

describe("getHubtelCsRuntime registration", () => {
  afterEach(() => { vi.unstubAllEnvs() })
  it("registers the airtime_orders order adapter", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321")
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    const { getOrderAdapter } = await import("./adapters")
    const { getHubtelCsRuntime } = await import("./runtime")
    getHubtelCsRuntime()
    expect(getOrderAdapter("airtime_orders")).toBeDefined()
  })
})
