import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

const createDraftMock = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock("@/lib/ai-drafts/repo", () => ({ createDraft: (...a: unknown[]) => createDraftMock.fn(...a) }))

import { CATALOG } from "./index"
import type { CatalogEntry } from "./types"
import { ADMIN_PAGES } from "./pages"
import {
  adminLookup,
  findAdminActions,
  prepareAdminChange,
  type CatalogToolCtx,
} from "./tools"
import { aiTools, adminToolNames, executeToolCall } from "@/lib/ai-tools"
import { MAX_TOOL_RESULT_CHARS, runAgenticLoop } from "@/lib/ai-agentic-loop"
import { buildAdminPrompt } from "@/lib/ai-prompts"
import { adminCatalogBlock } from "@/lib/ai-prompts/admin-catalog-block"

const ADMIN = "11111111-1111-4111-8111-111111111111"
const UUID = "123e4567-e89b-12d3-a456-426614174000"
const ctx: CatalogToolCtx = { userId: ADMIN, jwtToken: "jwt-abc", baseUrl: "http://app.test" }

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "orders.get",
    area: "orders",
    page: "/admin/orders",
    pageTitle: "Orders",
    summary: "Get one order",
    method: "GET",
    path: "/api/admin/orders/:id",
    params: { id: "uuid" },
    query: z.object({ verbose: z.boolean().optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["order.id", "order.status"],
    ...over,
  }
}

const added: CatalogEntry[] = []
function add(e: CatalogEntry) {
  CATALOG.push(e)
  added.push(e)
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-value")
  createDraftMock.fn.mockReset()
  createDraftMock.fn.mockImplementation(async (_db: unknown, i: Record<string, unknown>) => ({
    id: "d-1",
    expires_at: "2030-01-01T00:00:00.000Z",
    ...i,
  }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const e of added) CATALOG.splice(CATALOG.indexOf(e), 1)
  added.length = 0
})

function okFetch(body: unknown, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal("fetch", f)
  return f
}

describe("find_admin_actions", () => {
  it("returns at most 8 entries with input shapes and never leaks secret field names or values", () => {
    for (let i = 0; i < 10; i++) {
      add(
        entry({
          id: `refund.do${i}`,
          summary: "Refund an order",
          kind: "change",
          method: "POST",
          path: "/api/admin/refunds",
          params: undefined,
          query: undefined,
          body: z.object({ order_id: z.string(), amount: z.number().optional() }).strict(),
          risk: "money",
          secretFields: i === 0 ? [{ name: "api_token", label: "Provider API token", min: 8, max: 80 }] : undefined,
        }),
      )
    }
    const out = findAdminActions({ query: "refund" })
    expect(out.actions.length).toBe(8)
    const first = out.actions.find((a) => a.id === "refund.do0")!
    expect(first).toMatchObject({ pageTitle: "Orders", page: "/admin/orders", kind: "change", risk: "money" })
    expect(first.input).toContain("body.order_id: string (required)")
    expect(first.input).toContain("body.amount: number (optional)")
    expect(first.input).toContain("set in the card's secure box: Provider API token")
    expect(JSON.stringify(first)).not.toContain("api_token")
  })

  it("points typed-card entries at their tool", () => {
    add(entry({ id: "users.wallet", summary: "Adjust wallet", kind: "change", typedCard: "prepare_wallet_adjustment" }))
    const out = findAdminActions({ query: "wallet" })
    expect(out.actions[0].input).toBe("use prepare_wallet_adjustment")
  })

  it("filters by page and describes params", () => {
    add(entry())
    const out = findAdminActions({ query: "order", page: "/admin/orders" })
    expect(out.actions[0].input).toContain("params.id: uuid (required)")
    expect(out.actions[0].input).toContain("query.verbose: boolean (optional)")
  })
})

describe("admin_lookup", () => {
  it("refuses interactive_only with the cron secret as token, no fetch", async () => {
    add(entry())
    const f = okFetch({})
    const r = await adminLookup({ id: "orders.get", input: { params: { id: UUID } } }, { ...ctx, jwtToken: "cron-secret-value" })
    expect(r).toMatchObject({ refused: true, code: "interactive_only" })
    expect(f).not.toHaveBeenCalled()
  })

  it("refuses when there is no user id or the run is background", async () => {
    add(entry())
    const f = okFetch({})
    expect(await adminLookup({ id: "orders.get", input: { params: { id: UUID } } }, { ...ctx, userId: undefined })).toMatchObject({ refused: true, code: "interactive_only" })
    expect(await adminLookup({ id: "orders.get", input: { params: { id: UUID } } }, { ...ctx, background: true })).toMatchObject({ refused: true, code: "interactive_only" })
    expect(f).not.toHaveBeenCalled()
  })

  it("a large lookup reaches the model as valid JSON inside the fence, within the loop limit, with truncated:true", async () => {
    add(entry({ resultKeep: ["rows[].id", "rows[].note"] }))
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: `row-${i}`, note: "n".repeat(60) }))
    okFetch({ rows })
    let seen: { content: string }[] = []
    const provider = {
      createMessage: vi
        .fn()
        .mockResolvedValueOnce({
          text: "", stopReason: "tool_use", anthropicContent: [],
          toolCalls: [{ id: "t1", name: "admin_lookup", input: { id: "orders.get", input: { params: { id: UUID } } } }],
        })
        .mockImplementationOnce(async (a: { messages: { content: { content: string }[] }[] }) => {
          seen = a.messages[a.messages.length - 1].content
          return { text: "done", stopReason: "end_turn", anthropicContent: [], toolCalls: [] }
        }),
    }
    await runAgenticLoop({
      provider: provider as never, model: "m", system: { stable: "s", volatile: "v" } as never, context: "admin",
      messages: [], toolCtx: { userId: ADMIN, jwtToken: "jwt-abc", userRole: "admin", baseUrl: "http://app.test" },
      adminCatalog: true,
    })
    const content = seen[0].content
    expect(content.startsWith("<data>\n")).toBe(true)
    expect(content.endsWith("\n</data>")).toBe(true)
    const inner = content.slice("<data>\n".length, -"\n</data>".length)
    expect(inner.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
    expect(inner).not.toContain("…[truncated]")
    const parsed = JSON.parse(inner)
    expect(parsed.truncated).toBe(true)
    expect(parsed.data.rows.length).toBeGreaterThan(0)
  })

  it("says 'in time' only for a timeout", async () => {
    add(entry())
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("t", "TimeoutError") }))
    const t = (await adminLookup({ id: "orders.get", input: { params: { id: UUID } } }, ctx)) as { error: string }
    expect(t.error).toContain("in time")
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed") }))
    const n = (await adminLookup({ id: "orders.get", input: { params: { id: UUID } } }, ctx)) as { error: string }
    expect(n.error).not.toContain("in time")
  })

  it("refuses a change entry without calling the route", async () => {
    add(entry({ id: "orders.del", kind: "change", method: "DELETE" }))
    const f = okFetch({})
    const r = await adminLookup({ id: "orders.del", input: { params: { id: UUID } } }, ctx)
    expect(r).toMatchObject({ refused: true, code: "not_a_lookup" })
    expect(f).not.toHaveBeenCalled()
  })

  it("calls GET with the admin JWT and returns only resultKeep fields", async () => {
    add(entry())
    const f = okFetch({ order: { id: "o1", status: "pending", secret: "s", note: "x" }, extra: 1 })
    const r = (await adminLookup({ id: "orders.get", input: { params: { id: UUID }, query: { verbose: true } } }, ctx)) as { data: unknown }
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`http://app.test/api/admin/orders/${UUID}?verbose=true`)
    expect(init.method).toBe("GET")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-abc")
    expect(JSON.stringify(r.data)).not.toContain("secret")
    expect(JSON.stringify(r.data)).not.toContain("extra")
    expect(JSON.stringify(r.data)).toContain("pending")
  })

  it("turns a non-2xx into a short tool error with the route's error text", async () => {
    add(entry())
    okFetch({ error: "x".repeat(500) }, 404)
    const r = (await adminLookup({ id: "orders.get", input: { params: { id: UUID } } }, ctx)) as { error: string }
    expect(r.error.length).toBeLessThanOrEqual(200)
    expect(r.error.startsWith("xxx")).toBe(true)
  })

  it("turns a network failure into a tool error", async () => {
    add(entry())
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom") }))
    const r = (await adminLookup({ id: "orders.get", input: { params: { id: UUID } } }, ctx)) as { error: string }
    expect(r.error).toBeTruthy()
  })

  it("the loop puts the filtered result inside the <data> fence", async () => {
    add(entry())
    okFetch({ order: { id: "o1", status: "pending", password: "pw" } })
    let seen: unknown
    const provider = {
      createMessage: vi
        .fn()
        .mockResolvedValueOnce({
          text: "", stopReason: "tool_use", anthropicContent: [],
          toolCalls: [{ id: "t1", name: "admin_lookup", input: { id: "orders.get", input: { params: { id: UUID } } } }],
        })
        .mockImplementationOnce(async (a: { messages: unknown[] }) => {
          seen = a.messages[a.messages.length - 1]
          return { text: "done", stopReason: "end_turn", anthropicContent: [], toolCalls: [] }
        }),
    }
    await runAgenticLoop({
      provider: provider as never, model: "m", system: { stable: "s", volatile: "v" } as never, context: "admin",
      messages: [], toolCtx: { userId: ADMIN, jwtToken: "jwt-abc", userRole: "admin", baseUrl: "http://app.test" },
      adminCatalog: true,
    })
    const content = JSON.stringify(seen)
    expect(content).toContain("<data>")
    expect(content).toContain("pending")
    expect(content).not.toContain("pw")
  })
})

describe("prepare_admin_change", () => {
  const change = () =>
    entry({
      id: "settings.banner",
      kind: "change",
      method: "POST",
      path: "/api/admin/settings/banner",
      params: undefined,
      query: undefined,
      body: z.object({ text: z.string() }).strict(),
      card: async () => ({ summary: "Set banner", lines: [{ label: "Text", value: "hi" }] }),
    })
  const db = {} as SupabaseClient

  it("creates an admin_route_call draft for a change entry", async () => {
    add(change())
    const r = await prepareAdminChange(db, { id: "settings.banner", input: { body: { text: "hi" } } }, ctx)
    expect(r).toMatchObject({ draft_id: "d-1" })
    expect(createDraftMock.fn.mock.calls[0][1]).toMatchObject({ action: "admin_route_call" })
  })

  it("refuses interactive_only for the cron secret, background or a missing user", async () => {
    add(change())
    const body = { id: "settings.banner", input: { body: { text: "hi" } } }
    expect(await prepareAdminChange(db, body, { ...ctx, jwtToken: "cron-secret-value" })).toMatchObject({ refused: true, code: "interactive_only" })
    expect(await prepareAdminChange(db, body, { ...ctx, background: true })).toMatchObject({ refused: true, code: "interactive_only" })
    expect(await prepareAdminChange(db, body, { ...ctx, userId: undefined })).toMatchObject({ refused: true })
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("refuses a lookup entry", async () => {
    add(entry())
    expect(await prepareAdminChange(db, { id: "orders.get", input: { params: { id: UUID } } }, ctx)).toMatchObject({ refused: true, code: "not_a_change" })
  })
})

describe("switch wiring", () => {
  it("with the switch off the admin list has no catalog tools and the new tools are not callable", async () => {
    const off = aiTools("admin").map((t) => t.name)
    for (const n of ["find_admin_actions", "admin_lookup", "prepare_admin_change"]) expect(off).not.toContain(n)
    expect(off).toContain("update_order_status")
    const r = await executeToolCall("find_admin_actions", { query: "x" }, { baseUrl: "http://x", userId: ADMIN, userRole: "admin", context: "admin" })
    expect(r).toEqual({ error: "tool_not_available" })
  })

  it("with the switch on, acting tools are gone and the three catalog tools are there", () => {
    const on = adminToolNames(true)
    for (const n of ["find_admin_actions", "admin_lookup", "prepare_admin_change", "prepare_wallet_adjustment", "get_all_orders"]) expect(on).toContain(n)
    for (const n of ["update_order_status", "manage_shop", "toggle_ordering", "send_notification", "bulk_manual_fulfill"]) expect(on).not.toContain(n)
    expect(adminToolNames(false)).toEqual(aiTools("admin").map((t) => t.name))
    expect(aiTools("admin", undefined, true).map((t) => t.name)).toEqual(on)
  })

  it("the switch never adds catalog tools to other contexts", () => {
    expect(aiTools("dashboard", undefined, true).map((t) => t.name)).toEqual(aiTools("dashboard").map((t) => t.name))
  })

  it("on: find_admin_actions runs through executeToolCall for an admin", async () => {
    add(entry({ summary: "Get one order" }))
    const r = (await executeToolCall("find_admin_actions", { query: "order" }, { baseUrl: "http://x", userId: ADMIN, userRole: "admin", context: "admin", adminCatalog: true })) as { actions: unknown[] }
    expect(r.actions.length).toBeGreaterThan(0)
  })

  it("on: a non-admin caller is refused", async () => {
    const r = await executeToolCall("find_admin_actions", { query: "order" }, { baseUrl: "http://x", userId: "u", userRole: "user", context: "admin", adminCatalog: true })
    expect(r).toEqual({ error: "Not authorized" })
  })
})

describe("admin prompt block", () => {
  const base = { ussdDialCode: "*1#", firstName: "A", lastName: "B", today: "2026-01-02", cardNonce: "N" }

  it("lists every page title with its path and has the rule sentence", () => {
    const block = adminCatalogBlock()
    for (const p of ADMIN_PAGES) {
      expect(block, p.path).toContain(`${p.title} (${p.path})`)
    }
    expect(block).toContain("Only prepare a change the admin asked for in their own message.")
  })

  it("is appended at the end of stable only when on", () => {
    const off = buildAdminPrompt(base)
    expect(buildAdminPrompt({ ...base, adminCatalog: false })).toEqual(off)
    const on = buildAdminPrompt({ ...base, adminCatalog: true })
    expect(on.volatile).toEqual(off.volatile)
    expect(on.stable.startsWith(off.stable)).toBe(true)
    expect(on.stable.endsWith(adminCatalogBlock())).toBe(true)
  })
})
