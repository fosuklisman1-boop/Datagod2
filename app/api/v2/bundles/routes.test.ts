import { describe, it, expect, vi, beforeEach } from "vitest"

// Capture what each route hands to withV2 and drive its handler directly.
const h = vi.hoisted(() => ({
  captured: [] as { opts: any; handler: (req: any, ctx: any) => Promise<any> }[],
  deps: {
    catalog: vi.fn(async (_n: unknown, _c: unknown) => ({ status: 200, data: {} })),
    purchase: vi.fn(async (_b: unknown, _c: unknown) => ({ status: 201, data: { order: {} } })),
    list: vi.fn(async (_c: unknown) => ({ status: 200, data: {} })),
    order: vi.fn(async (_r: string, _c: unknown) => ({ status: 200, data: {} })),
  },
}))

vi.mock("@/lib/api-v2/handler", () => ({
  withV2: (opts: any, handler: any) => {
    h.captured.push({ opts, handler })
    return handler
  },
}))
vi.mock("@/lib/api-v2/endpoints/bundles-deps", () => ({ realBundleDeps: () => ({ tag: "real-deps" }) }))
vi.mock("@/lib/api-v2/endpoints/bundles", () => ({
  bundleCatalogHandler: () => h.deps.catalog,
  purchaseBundleHandler: () => h.deps.purchase,
  bundleListHandler: () => h.deps.list,
  bundleOrderHandler: () => h.deps.order,
}))

const CTX = { keyId: "k", userId: "u", role: "dealer", keyType: "commission", environment: "live", firstName: null }

async function load(path: string) {
  h.captured.length = 0
  vi.resetModules()
  const mod = await import(path)
  return { mod, route: h.captured[0] }
}

const req = (url: string, body?: unknown) => ({
  nextUrl: new URL(url),
  json: async () => {
    if (body === undefined) throw new Error("no body")
    return body
  },
})

beforeEach(() => {
  for (const f of Object.values(h.deps)) f.mockClear()
})

describe("GET /api/v2/bundles/catalog", () => {
  it("is a commission-key, status-group route and passes the network query value through", async () => {
    const { mod, route } = await load("./catalog/route")
    expect(route.opts).toEqual({ requiredType: "commission", group: "status", endpoint: "/api/v2/bundles/catalog" })
    expect(mod.maxDuration).toBe(60)
    expect(mod.dynamic).toBe("force-dynamic")
    expect(typeof mod.GET).toBe("function")
    await route.handler(req("http://x/api/v2/bundles/catalog?network=MTN"), CTX)
    expect(h.deps.catalog).toHaveBeenLastCalledWith("MTN", CTX)
    await route.handler(req("http://x/api/v2/bundles/catalog"), CTX)
    expect(h.deps.catalog).toHaveBeenLastCalledWith(null, CTX)
  })
})

describe("POST /api/v2/bundles/purchase", () => {
  it("is a commission-key, purchase-group route (in-process cap when Redis is degraded) with the full 300 s budget", async () => {
    const { mod, route } = await load("./purchase/route")
    expect(route.opts).toEqual({
      requiredType: "commission",
      group: "purchase",
      endpoint: "/api/v2/bundles/purchase",
      fallbackLimitWhenDegraded: true,
    })
    expect(mod.maxDuration).toBe(300)
    expect(mod.dynamic).toBe("force-dynamic")
    expect(typeof mod.POST).toBe("function")
  })

  it("hands the parsed JSON body to the handler; an unreadable body becomes undefined (a 400 there)", async () => {
    const { route } = await load("./purchase/route")
    await route.handler(req("http://x/api/v2/bundles/purchase", { reference: "r" }), CTX)
    expect(h.deps.purchase).toHaveBeenLastCalledWith({ reference: "r" }, CTX)
    await route.handler(req("http://x/api/v2/bundles/purchase"), CTX)
    expect(h.deps.purchase).toHaveBeenLastCalledWith(undefined, CTX)
  })
})

describe("GET /api/v2/bundles/orders", () => {
  it("list: commission key, status group", async () => {
    const { mod, route } = await load("./orders/route")
    expect(route.opts).toEqual({ requiredType: "commission", group: "status", endpoint: "/api/v2/bundles/orders" })
    expect(mod.maxDuration).toBe(60)
    await route.handler(req("http://x/api/v2/bundles/orders"), CTX)
    expect(h.deps.list).toHaveBeenCalledWith(CTX)
  })

  it("detail: commission key, status group, reference read from the path", async () => {
    const { mod, route } = await load("./orders/[reference]/route")
    expect(route.opts).toEqual({ requiredType: "commission", group: "status", endpoint: "/api/v2/bundles/orders/[reference]" })
    expect(mod.maxDuration).toBe(60)
    await route.handler(req("http://x/api/v2/bundles/orders/BND-001"), CTX)
    expect(h.deps.order).toHaveBeenLastCalledWith("BND-001", CTX)
  })
})
