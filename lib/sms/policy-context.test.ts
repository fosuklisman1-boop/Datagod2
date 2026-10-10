import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, { data: any; error: any }>,
    filters: [] as { table: string; col: string; val: any }[],
    rpc: { data: null as any, error: null as any },
    rpcCalls: [] as { fn: string; args: any }[],
    rpcHangs: false,
    settings: null as any,
  }
  const fake = {
    from: (table: string) => {
      const res = () => state.tables[table] ?? { data: null, error: null }
      const chain: any = {
        select: () => chain,
        neq: () => chain,
        gte: () => chain,
        eq: (col: string, val: any) => { state.filters.push({ table, col, val }); return chain },
        maybeSingle: () => Promise.resolve(res()),
        then: (ok: any, bad: any) => Promise.resolve(res()).then(ok, bad),
      }
      return chain
    },
    rpc: (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args })
      return state.rpcHangs ? new Promise(() => {}) : Promise.resolve(state.rpc)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("./platform-settings", async (orig) => {
  const actual = await orig<typeof import("./platform-settings")>()
  return { ...actual, loadSmsSettings: () => Promise.resolve(h.state.settings) }
})

import {
  audienceFor, buildShadow, PLATFORM_ROOT_DOMAIN, resolveCampaignSender, loadUsage,
  shadowPolicy, shadowPolicyWithin, loadOwnDomains,
} from "./policy-context"
import { DEFAULT_SMS_SETTINGS } from "./platform-settings"

const account = (mode: string) => ({ data: { mode, status: "active", owner_type: "shop", review_hold: false, user_id: "u" }, error: null })

beforeEach(() => {
  h.state.tables = {}
  h.state.filters.length = 0
  h.state.rpcCalls.length = 0
  h.state.rpcHangs = false
  h.state.rpc = { data: [{ sends_last_hour: 1, recipients_last_24h: 10 }], error: null }
  h.state.settings = { ...DEFAULT_SMS_SETTINGS, senderPool: ["POOLNAME"] }
})

describe("audienceFor", () => {
  it("maps owner types", () => {
    expect(audienceFor("platform", "admin")).toBe("admin")
    expect(audienceFor("shop", "dealer")).toBe("shop_owner")
    expect(audienceFor("sub_agent", "sub_agent")).toBe("sub_agent")
    expect(audienceFor("individual", "dealer")).toBe("dealer")
    expect(audienceFor("individual", null)).toBe("user")
  })
})

describe("buildShadow", () => {
  it("records the decision, record-only", () => {
    const s = buildShadow({ decision: "block", code: "LINK_NOT_ALLOWED", reason: "r", flags: [] }, false, new Date("2026-10-10T00:00:00Z"))
    expect(s).toEqual({ decision: "block", code: "LINK_NOT_ALLOWED", reason: "r", flags: [], enforced: false, evaluated_at: "2026-10-10T00:00:00.000Z" })
  })
})

it("root domain is datagod.store", () => expect(PLATFORM_ROOT_DOMAIN).toBe("datagod.store"))

describe("resolveCampaignSender", () => {
  it("empty → platform sender", async () => {
    expect(await resolveCampaignSender("a1", "  ")).toEqual({ kind: "platform", name: null, kycFree: false })
    expect(await resolveCampaignSender("a1")).toEqual({ kind: "platform", name: null, kycFree: false })
  })

  it("own active row → own, kycFree passed through, lookup filtered on active + uppercased name", async () => {
    h.state.tables.sms_sender_ids = { data: { sender_id: "MYSHOP", kyc_free: true }, error: null }
    expect(await resolveCampaignSender("a1", "myshop")).toEqual({ kind: "own", name: "MYSHOP", kycFree: true })
    const f = h.state.filters.filter((x) => x.table === "sms_sender_ids")
    expect(f).toContainEqual({ table: "sms_sender_ids", col: "local_status", val: "active" })
    expect(f).toContainEqual({ table: "sms_sender_ids", col: "sender_id", val: "MYSHOP" })
    expect(f).toContainEqual({ table: "sms_sender_ids", col: "sms_account_id", val: "a1" })
  })

  it("no own row + business + pool name → pool", async () => {
    h.state.tables.sms_accounts = account("business")
    expect(await resolveCampaignSender("a1", "poolname")).toEqual({ kind: "pool", name: "POOLNAME", kycFree: false })
  })

  it("platform account + pool name → null", async () => {
    h.state.tables.sms_accounts = account("platform")
    expect(await resolveCampaignSender("a1", "poolname")).toBeNull()
  })

  it("unknown name → null", async () => {
    h.state.tables.sms_accounts = account("business")
    expect(await resolveCampaignSender("a1", "nobody")).toBeNull()
  })

  it("own-row read error is logged and treated as not found", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.tables.sms_sender_ids = { data: null, error: { message: "boom" } }
    h.state.tables.sms_accounts = account("platform")
    expect(await resolveCampaignSender("a1", "myshop")).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe("loadUsage", () => {
  it("maps the rpc row incl. a string bigint", async () => {
    h.state.rpc = { data: [{ sends_last_hour: 3, recipients_last_24h: "1200" }], error: null }
    expect(await loadUsage("a1")).toEqual({ sendsLastHour: 3, recipientsLast24h: 1200 })
    expect(h.state.rpcCalls[0]).toEqual({ fn: "sms_account_usage", args: { p_account_id: "a1" } })
  })
  it("throws on rpc error", async () => {
    h.state.rpc = { data: null, error: { message: "nope" } }
    await expect(loadUsage("a1")).rejects.toThrow(/nope/)
  })
})

describe("loadOwnDomains", () => {
  it("throws on error", async () => {
    h.state.tables.custom_domains = { data: null, error: { message: "dom boom" } }
    await expect(loadOwnDomains()).rejects.toThrow(/dom boom/)
  })
})

describe("shadowPolicy", () => {
  const args = { accountId: "a1", sender: { kind: "platform" as const, name: null, kycFree: false }, recipientCount: 1, message: "hello" }
  beforeEach(() => {
    h.state.tables.custom_domains = { data: [], error: null }
    h.state.tables.sms_accounts = account("platform")
    h.state.tables.users = { data: { role: "dealer" }, error: null }
  })

  it("loader error → { mode: null, shadow: { error } }, not a clean decision", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.rpc = { data: null, error: { message: "usage down" } }
    const r = await shadowPolicy(args)
    expect(r.mode).toBeNull()
    expect((r.shadow as any).error).toMatch(/usage down/)
    expect((r.shadow as any).decision).toBeUndefined()
    spy.mockRestore()
  })

  it("account read error / not found → error shadow", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.tables.sms_accounts = { data: null, error: { message: "acct down" } }
    expect((await shadowPolicy(args)).shadow).toHaveProperty("error")
    h.state.tables.sms_accounts = { data: null, error: null }
    expect((await shadowPolicy(args)).shadow).toHaveProperty("error")
    spy.mockRestore()
  })

  it("records enforced:false even when policyEnforced=true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    h.state.settings = { ...DEFAULT_SMS_SETTINGS, policyEnforced: true }
    const r = await shadowPolicy(args)
    expect(r.mode).toBe("platform")
    expect((r.shadow as any).enforced).toBe(false)
    expect((r.shadow as any).decision).toBeDefined()
    warn.mockRestore()
  })
})

describe("shadowPolicyWithin", () => {
  afterEach(() => vi.useRealTimers())

  it("returns the timeout shadow when the policy is slow", async () => {
    vi.useFakeTimers()
    h.state.rpcHangs = true
    h.state.tables.custom_domains = { data: [], error: null }
    h.state.tables.sms_accounts = account("platform")
    const p = shadowPolicyWithin({ accountId: "a1", sender: { kind: "platform", name: null, kycFree: false }, recipientCount: 1, message: "hi" }, 1500)
    await vi.advanceTimersByTimeAsync(1500)
    const r = await p
    expect(r.mode).toBeNull()
    expect((r.shadow as any).error).toBe("timeout")
  })
})
