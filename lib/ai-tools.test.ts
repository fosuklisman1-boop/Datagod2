import { describe, it, expect, vi, beforeEach } from "vitest"
import { aiTools, executeToolCall } from "@/lib/ai-tools"

vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: vi.fn(),
  fetchShopNetworks: vi.fn(),
}))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({
  setShopPref: vi.fn(),
  getShopPref: vi.fn(),
}))

import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { setShopPref } from "@/lib/whatsapp-bot/shop-prefs"

describe("aiTools whatsapp_shop context", () => {
  it("returns exactly the three shop-scoped tools", () => {
    const tools = aiTools("whatsapp_shop").map(t => t.name)
    expect(tools).toEqual(["resolve_shop_code", "get_shop_packages", "place_shop_order"])
  })
})

describe("executeToolCall resolve_shop_code", () => {
  const baseCtx = { baseUrl: "http://localhost:3000", phone: "233559919037" }

  // vitest.config.ts doesn't set clearMocks — without this, setShopPref's call
  // history leaks across `it` blocks in this describe and the "not remembered"
  // assertions below would see the prior test's call.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("resolves a valid active code and remembers it", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN", "Telecel"])

    const result = await executeToolCall("resolve_shop_code", { code: "AB12CD" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(true)
    expect(result.shopName).toBe("Kofi's Data Hub")
    expect(setShopPref).toHaveBeenCalledWith("233559919037", "code-1")
  })

  it("returns a reason without remembering an invalid code", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue(null)

    const result = await executeToolCall("resolve_shop_code", { code: "ZZZZZZ" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(false)
    expect(setShopPref).not.toHaveBeenCalled()
  })

  it("rejects an inactive shop without remembering it", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-2", shopId: "shop-2", shopName: "Ama's Shop",
      parentShopId: null, status: "suspended", tokenBalance: 5, whatsappActivated: true,
    })

    const result = await executeToolCall("resolve_shop_code", { code: "CD34EF" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(false)
    expect(setShopPref).not.toHaveBeenCalled()
  })
})
