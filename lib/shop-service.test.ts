import { describe, it, expect, vi, beforeEach } from "vitest"

const rpcMock = vi.fn()
const fromMock = vi.fn()

vi.mock("./supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe("shopService.getLinkedCustomDomain", () => {
  it("returns null when the shop has no linked domain", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null })
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
    expect(rpcMock).toHaveBeenCalledWith("get_linked_custom_domain", { p_subdomain: "my-shop" })
  })

  it("returns the domain when a linked active domain exists for this shop", async () => {
    rpcMock.mockResolvedValue({ data: "clingshub.com", error: null })
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBe("clingshub.com")
    expect(rpcMock).toHaveBeenCalledWith("get_linked_custom_domain", { p_subdomain: "my-shop" })
  })

  it("fails open to null on a query error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "db down", code: "PGRST000" } })
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
  })

  it("passes the subdomain as p_subdomain parameter to the RPC function", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null })
    const { shopService } = await import("./shop-service")

    await shopService.getLinkedCustomDomain("test-subdomain")

    expect(rpcMock).toHaveBeenCalledWith("get_linked_custom_domain", { p_subdomain: "test-subdomain" })
  })
})
