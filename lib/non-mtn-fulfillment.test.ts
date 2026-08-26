vi.mock("@/lib/mtn-providers/factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mtn-providers/factory")>()
  return {
    ...actual,
    getProviderNameForNetwork: vi.fn(),
    getProviderByName: vi.fn(),
  }
})

vi.mock("@/lib/mtn-fulfillment", () => ({
  saveMTNTracking: vi.fn().mockResolvedValue("tracking-row-id"),
}))

vi.mock("@/lib/at-ishare-service", () => ({
  atishareService: { fulfillOrder: vi.fn() },
}))

import { createNonMTNOrder, normalizeNetworkKey } from "./non-mtn-fulfillment"
import { getProviderNameForNetwork, getProviderByName } from "./mtn-providers/factory"
import { saveMTNTracking } from "./mtn-fulfillment"
import type { MTNProvider } from "./mtn-providers/types"

describe("normalizeNetworkKey", () => {
  it("normalizes AT-iShare variants (spaced, unspaced, lowercase)", () => {
    expect(normalizeNetworkKey("AT - iShare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("AT-iShare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("at - ishare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("AT-ISHARE")).toBe("AT - ISHARE")
  })

  it("normalizes AT-BigTime variants (spaced, unspaced, lowercase)", () => {
    expect(normalizeNetworkKey("AT - BigTime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("AT-BigTime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("at - bigtime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("AT-BIGTIME")).toBe("AT - BIGTIME")
  })

  it("normalizes Telecel variants", () => {
    expect(normalizeNetworkKey("Telecel")).toBe("TELECEL")
    expect(normalizeNetworkKey("telecel")).toBe("TELECEL")
    expect(normalizeNetworkKey("TELECEL")).toBe("TELECEL")
  })

  it("falls back to AIRTELTIGO for a generic AirtelTigo label", () => {
    expect(normalizeNetworkKey("AirtelTigo")).toBe("AIRTELTIGO")
    expect(normalizeNetworkKey("AIRTELTIGO")).toBe("AIRTELTIGO")
  })
})

/** Minimal fake MTNProvider — only createOrder matters to createNonMTNOrder. */
function fakeProvider(name: string, createOrderResult: any): MTNProvider {
  return {
    name,
    createOrder: vi.fn().mockResolvedValue(createOrderResult),
    checkOrderStatus: vi.fn(),
    checkBalance: vi.fn(),
  }
}

describe("createNonMTNOrder", () => {
  const baseParams = {
    phoneNumber: "0244000000",
    sizeGb: 5,
    orderId: "order-1",
    network: "Telecel",
    orderType: "shop" as const,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("saves a real tracking row when the provider call succeeds (order_id used as-is)", async () => {
    vi.mocked(getProviderNameForNetwork).mockResolvedValue("xpress")
    const provider = fakeProvider("xpress", { success: true, order_id: "X", message: "Order queued" })
    vi.mocked(getProviderByName).mockReturnValue(provider)

    const result = await createNonMTNOrder(baseParams)

    expect(result.success).toBe(true)
    expect(saveMTNTracking).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveMTNTracking).mock.calls[0][0]).toBe("order-1")
    expect(vi.mocked(saveMTNTracking).mock.calls[0][1]).toBe("X")
  })

  it("saves a FAILED_INIT_ tracking row (not the echoed order_id) when the provider call fails — AgentPortalGH whitelist-block shape", async () => {
    vi.mocked(getProviderNameForNetwork).mockResolvedValue("agentportalgh")
    const provider = fakeProvider("agentportalgh", {
      success: false,
      order_id: "X", // AgentPortalGH echoes the reference back even on a whitelist-block failure
      message: "Rejected by provider",
      error_type: "WHITELIST_BLOCKED",
    })
    vi.mocked(getProviderByName).mockReturnValue(provider)

    const result = await createNonMTNOrder(baseParams)

    expect(result.success).toBe(false)
    expect(saveMTNTracking).toHaveBeenCalledTimes(1)
    const [, mtnOrderIdArg] = vi.mocked(saveMTNTracking).mock.calls[0]
    expect(mtnOrderIdArg).not.toBe("X")
    expect(String(mtnOrderIdArg)).toMatch(/^FAILED_INIT_\d+$/)
  })

  it("uses an explicit providerOverride when it's capability-checked for the network", async () => {
    // Default resolver deliberately returns something different (codecraft) so we can
    // prove the override — not the resolved default — is what actually got used.
    vi.mocked(getProviderNameForNetwork).mockResolvedValue("codecraft")
    const provider = fakeProvider("xpress", { success: true, order_id: "Y", message: "Order queued" })
    vi.mocked(getProviderByName).mockReturnValue(provider)

    const result = await createNonMTNOrder({ ...baseParams, network: "AT - iShare", providerOverride: "xpress" })

    expect(getProviderNameForNetwork).not.toHaveBeenCalled()
    expect(getProviderByName).toHaveBeenCalledWith("xpress")
    expect(result.provider).toBe("xpress")
  })

  it("falls back to the admin-configured provider when providerOverride is not capable for the network (e.g. sykes is MTN-only)", async () => {
    vi.mocked(getProviderNameForNetwork).mockResolvedValue("xpress")
    const provider = fakeProvider("xpress", { success: true, order_id: "Z", message: "Order queued" })
    vi.mocked(getProviderByName).mockReturnValue(provider)

    const result = await createNonMTNOrder({ ...baseParams, network: "AT - iShare", providerOverride: "sykes" })

    expect(getProviderNameForNetwork).toHaveBeenCalled()
    expect(getProviderByName).toHaveBeenCalledWith("xpress")
    expect(getProviderByName).not.toHaveBeenCalledWith("sykes")
    expect(result.provider).toBe("xpress")
  })
})
