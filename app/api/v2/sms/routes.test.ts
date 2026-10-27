import { describe, it, expect, vi, beforeEach } from "vitest"

// Capture what each route hands to withV2 and drive its handler directly.
const h = vi.hoisted(() => ({
  captured: [] as { opts: any; handler: (req: any, ctx: any) => Promise<any> }[],
  deps: {
    send: vi.fn(async (_b: unknown, _c: unknown) => ({ status: 201, data: { send: {} } })),
    balance: vi.fn(async (_c: unknown) => ({ status: 200, data: {} })),
    senders: vi.fn(async (_c: unknown) => ({ status: 200, data: {} })),
    campaigns: vi.fn(async (_q: unknown, _c: unknown) => ({ status: 200, data: {} })),
    campaign: vi.fn(async (_id: string, _c: unknown) => ({ status: 200, data: {} })),
  },
}))

vi.mock("@/lib/api-v2/handler", () => ({
  withV2: (opts: any, handler: any) => {
    h.captured.push({ opts, handler })
    return handler
  },
}))
vi.mock("@/lib/api-v2/endpoints/sms-deps", () => ({ realSmsDeps: () => ({ tag: "real-deps" }) }))
vi.mock("@/lib/api-v2/endpoints/sms", () => ({
  handleSmsSend: () => h.deps.send,
  handleSmsBalance: () => h.deps.balance,
  handleSmsSenders: () => h.deps.senders,
  handleSmsCampaigns: () => h.deps.campaigns,
  handleSmsCampaign: () => h.deps.campaign,
}))

const CTX = { keyId: "k", userId: "u", role: "dealer", keyType: "sms", environment: "live", firstName: null }

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

describe("POST /api/v2/sms/send", () => {
  it("is an sms-key, purchase-group, fail-closed route with the full 300 s budget", async () => {
    const { mod, route } = await load("./send/route")
    expect(route.opts).toEqual({
      requiredType: "sms",
      group: "purchase",
      endpoint: "/api/v2/sms/send",
      failClosedWhenLimiterDegraded: true,
    })
    expect(mod.maxDuration).toBe(300)
    expect(mod.dynamic).toBe("force-dynamic")
    expect(typeof mod.POST).toBe("function")
  })

  it("hands the parsed JSON body to the handler; an unreadable body becomes undefined (a 400 there)", async () => {
    const { route } = await load("./send/route")
    await route.handler(req("http://x/api/v2/sms/send", { reference: "r" }), CTX)
    expect(h.deps.send).toHaveBeenLastCalledWith({ reference: "r" }, CTX)
    await route.handler(req("http://x/api/v2/sms/send"), CTX)
    expect(h.deps.send).toHaveBeenLastCalledWith(undefined, CTX)
  })
})

describe("GET /api/v2/sms/balance and /senders", () => {
  it("balance uses the balance group and an sms key", async () => {
    const { mod, route } = await load("./balance/route")
    expect(route.opts).toEqual({ requiredType: "sms", group: "balance", endpoint: "/api/v2/sms/balance" })
    expect(mod.maxDuration).toBe(60)
    await route.handler(req("http://x/api/v2/sms/balance"), CTX)
    expect(h.deps.balance).toHaveBeenCalledWith(CTX)
  })

  it("senders uses the status group and an sms key", async () => {
    const { mod, route } = await load("./senders/route")
    expect(route.opts).toEqual({ requiredType: "sms", group: "status", endpoint: "/api/v2/sms/senders" })
    expect(mod.maxDuration).toBe(60)
    await route.handler(req("http://x/api/v2/sms/senders"), CTX)
    expect(h.deps.senders).toHaveBeenCalledWith(CTX)
  })
})

describe("GET /api/v2/sms/campaigns", () => {
  it("list: status group, sms key, passes page and status from the query string", async () => {
    const { mod, route } = await load("./campaigns/route")
    expect(route.opts).toEqual({ requiredType: "sms", group: "status", endpoint: "/api/v2/sms/campaigns" })
    expect(mod.maxDuration).toBe(60)
    await route.handler(req("http://x/api/v2/sms/campaigns?page=2&status=sent"), CTX)
    expect(h.deps.campaigns).toHaveBeenLastCalledWith({ page: "2", status: "sent" }, CTX)
    await route.handler(req("http://x/api/v2/sms/campaigns"), CTX)
    expect(h.deps.campaigns).toHaveBeenLastCalledWith({ page: null, status: null }, CTX)
  })

  it("detail: status group, sms key, campaign id read from the path (decoded; '' when undecodable)", async () => {
    const { mod, route } = await load("./campaigns/[campaignId]/route")
    expect(route.opts).toEqual({ requiredType: "sms", group: "status", endpoint: "/api/v2/sms/campaigns/[campaignId]" })
    expect(mod.maxDuration).toBe(60)
    await route.handler(req("http://x/api/v2/sms/campaigns/77"), CTX)
    expect(h.deps.campaign).toHaveBeenLastCalledWith("77", CTX)
    await route.handler(req("http://x/api/v2/sms/campaigns/%E0%A4%A"), CTX)
    expect(h.deps.campaign).toHaveBeenLastCalledWith("", CTX)
  })
})
