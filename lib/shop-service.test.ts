import { describe, it, expect, vi, beforeEach } from "vitest"

const selectMock = vi.fn()
const eqMock = vi.fn()
const notMock = vi.fn()
const orderMock = vi.fn()
const fromMock = vi.fn()

vi.mock("./supabase", () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Chainable builder: .from().select().eq().not().order() -> the final
  // awaited value. Each link returns `builder` except the terminal one,
  // which resolves via `builder.then` so `await builder` works directly
  // (matching how getLinkedCustomDomain will call it, with no `.single()`
  // or `.maybeSingle()` at the end — it needs the full row list to apply
  // the oldest-wins tie-break in application code).
})

function makeBuilder(result: { data: unknown; error: unknown }) {
  const builder: any = {
    select: selectMock.mockImplementation(() => builder),
    eq: eqMock.mockImplementation(() => builder),
    not: notMock.mockImplementation(() => builder),
    order: orderMock.mockImplementation(() => builder),
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return builder
}

describe("shopService.getLinkedCustomDomain", () => {
  it("returns null when the shop has no linked domain", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: [], error: null }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
  })

  it("returns the domain when exactly one active row links a shop with this subdomain", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [{ domain: "clingshub.com", created_at: "2026-09-01", linked_shop: { subdomain: "my-shop" } }],
      error: null,
    }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBe("clingshub.com")
  })

  it("ignores rows linked to a DIFFERENT shop's subdomain", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [{ domain: "otherbrand.com", created_at: "2026-09-01", linked_shop: { subdomain: "someone-else" } }],
      error: null,
    }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
  })

  it("picks the oldest linkage when more than one active domain links the same shop", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [
        { domain: "newer.com", created_at: "2026-09-15", linked_shop: { subdomain: "my-shop" } },
        { domain: "older.com", created_at: "2026-08-01", linked_shop: { subdomain: "my-shop" } },
      ],
      error: null,
    }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBe("older.com")
  })

  it("fails open to null on a query error", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: null, error: { message: "db down" } }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
  })

  it("filters to active, shop-linked rows only — a deactivated domain's linkage must never surface even if the row is somehow still returned", async () => {
    // The mock can't simulate real Postgres-side filtering, so this proves
    // the query is actually CONSTRUCTED with the is_active/linked_shop_id
    // filters this function depends on entirely (there's no JS-side
    // is_active re-check — the query is the only thing excluding a
    // deactivated domain's row). A regression that silently drops either
    // .eq("is_active", true) or .not("linked_shop_id", "is", null) from the
    // implementation would pass every other test in this file but fail
    // this one.
    fromMock.mockReturnValue(makeBuilder({ data: [], error: null }))
    const { shopService } = await import("./shop-service")

    await shopService.getLinkedCustomDomain("my-shop")

    expect(eqMock).toHaveBeenCalledWith("is_active", true)
    expect(notMock).toHaveBeenCalledWith("linked_shop_id", "is", null)
  })
})
