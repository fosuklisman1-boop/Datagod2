import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import type { CatalogEntry } from "@/lib/ai-admin-catalog/types"

const entries = vi.hoisted(() => ({ map: new Map<string, unknown>() }))
vi.mock("@/lib/ai-admin-catalog/index", () => ({
  getEntry: (id: string) => entries.map.get(id),
}))

const createDraftMock = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock("./repo", () => ({ createDraft: (...a: unknown[]) => createDraftMock.fn(...a) }))

import { prepareAdminRouteCall } from "./prepare-admin-route"
import { EXPIRY_MS } from "./types"

const ADMIN = "11111111-1111-4111-8111-111111111111"
const ctx = { adminId: ADMIN, conversationKey: "conv-1" }
const db = {} as SupabaseClient

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "settings.set_banner",
    area: "settings",
    page: "/admin/settings",
    pageTitle: "Settings",
    summary: "Set banner",
    method: "POST",
    path: "/api/admin/settings/banner",
    body: z.object({ text: z.string(), apiToken: z.string().optional() }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: async (input) => ({
      summary: "Set the banner",
      lines: [{ label: "Text", value: String((input.body as any)?.text) }],
    }),
    ...over,
  }
}

beforeEach(() => {
  entries.map.clear()
  createDraftMock.fn.mockReset()
  createDraftMock.fn.mockImplementation(async (_db: unknown, i: any) => ({
    id: "d-1",
    expires_at: "2030-01-01T00:00:00.000Z",
    ...i,
  }))
})

const refusedCode = (r: any) => (r.refused ? r.code : null)

describe("prepareAdminRouteCall", () => {
  it("refuses an unknown entry", async () => {
    const r = await prepareAdminRouteCall(db, ctx, "nope", {})
    expect(refusedCode(r)).toBe("unknown_action")
  })

  it("refuses a lookup entry as not_a_change", async () => {
    entries.map.set("x", entry({ id: "x", kind: "lookup", resultKeep: ["a"] }))
    expect(refusedCode(await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } }))).toBe("not_a_change")
  })

  it("points typed entries at their tool", async () => {
    entries.map.set("w", entry({ id: "w", typedCard: "prepare_wallet_adjustment" }))
    const r: any = await prepareAdminRouteCall(db, ctx, "w", { body: { text: "a" } })
    expect(r.code).toBe("use_typed_tool")
    expect(r.message).toContain("prepare_wallet_adjustment")
  })

  it("requires an admin id", async () => {
    entries.map.set("x", entry({ id: "x" }))
    const r = await prepareAdminRouteCall(db, { adminId: "", conversationKey: null }, "x", { body: { text: "a" } })
    expect(refusedCode(r)).toBe("admin_required")
  })

  it("refuses background callers", async () => {
    entries.map.set("x", entry({ id: "x" }))
    const r = await prepareAdminRouteCall(db, { ...ctx, background: true }, "x", { body: { text: "a" } })
    expect(refusedCode(r)).toBe("interactive_only")
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("refuses secrets in input and stores nothing", async () => {
    entries.map.set("x", entry({ id: "x", secretFields: [{ name: "apiToken", label: "Token", min: 8, max: 100 }] }))
    const r = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a", apiToken: "s3cret-value" } })
    expect(refusedCode(r)).toBe("secret_in_input")
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("passes bad_input through", async () => {
    entries.map.set("x", entry({ id: "x" }))
    const r = await prepareAdminRouteCall(db, ctx, "x", { body: { wrong: 1 } })
    expect(refusedCode(r)).toBe("bad_input")
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("stores a valid draft with params, expiry and card display", async () => {
    entries.map.set(
      "x",
      entry({
        id: "x",
        risk: "money",
        secretFields: [{ name: "apiToken", label: "Token", min: 8, max: 100 }],
      }),
    )
    const r: any = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "hello" } })
    expect(r.draft_id).toBe("d-1")
    expect(createDraftMock.fn).toHaveBeenCalledTimes(1)
    const arg = createDraftMock.fn.mock.calls[0][1]
    expect(arg).toMatchObject({
      userId: ADMIN,
      context: "admin",
      action: "admin_route_call",
      conversationKey: "conv-1",
      expiresInMs: EXPIRY_MS.admin,
      amountGhs: null,
    })
    expect(arg.params).toEqual({
      entryId: "x",
      req: { method: "POST", path: "/api/admin/settings/banner", query: "", body: { text: "hello" } },
    })
    expect(JSON.stringify(arg.params)).not.toContain("apiToken")
    expect(arg.display).toEqual({
      kind: "admin_route",
      entryId: "x",
      page: "/admin/settings",
      pageTitle: "Settings",
      summary: "Set the banner",
      lines: [{ label: "Text", value: "hello" }],
      risk: "money",
      secretFields: [{ name: "apiToken", label: "Token", min: 8, max: 100 }],
    })
  })

  it("shows a 5000-char message in full, never clipped", async () => {
    const msg = "m".repeat(4990) + "http://evil"
    entries.map.set(
      "x",
      entry({ id: "x", card: async () => ({ summary: "s", lines: [{ label: "Message", value: msg }] }) }),
    )
    const r: any = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } })
    expect(r.draft_id).toBe("d-1")
    expect(createDraftMock.fn.mock.calls[0][1].display.lines[0].value).toBe(msg)
  })

  it("accepts exactly 40 lines and a 6000-char value", async () => {
    entries.map.set(
      "x",
      entry({
        id: "x",
        card: async () => ({
          summary: "s",
          lines: Array.from({ length: 40 }, (_, i) => ({ label: `L${i}`, value: i === 0 ? "v".repeat(6000) : "v" })),
        }),
      }),
    )
    const r: any = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } })
    expect(r.draft_id).toBe("d-1")
    expect(createDraftMock.fn.mock.calls[0][1].display.lines).toHaveLength(40)
  })

  const TOO_LARGE = "This change is too large to show on a card. Use the page."

  it("refuses card_too_large for 41 lines, storing nothing", async () => {
    entries.map.set(
      "x",
      entry({
        id: "x",
        card: async () => ({ summary: "s", lines: Array.from({ length: 41 }, (_, i) => ({ label: `L${i}`, value: "v" })) }),
      }),
    )
    const r: any = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } })
    expect(r).toMatchObject({ refused: true, code: "card_too_large", message: TOO_LARGE })
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("refuses card_too_large for a 6001-char value, storing nothing", async () => {
    entries.map.set(
      "x",
      entry({ id: "x", card: async () => ({ summary: "s", lines: [{ label: "L", value: "v".repeat(6001) }] }) }),
    )
    const r: any = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } })
    expect(r).toMatchObject({ refused: true, code: "card_too_large", message: TOO_LARGE })
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("refuses card_too_large for a summary over 500 chars", async () => {
    entries.map.set("x", entry({ id: "x", card: async () => ({ summary: "s".repeat(501), lines: [] }) }))
    const r: any = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } })
    expect(r.code).toBe("card_too_large")
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("refuses card_error when card() throws, storing nothing", async () => {
    entries.map.set("x", entry({ id: "x", card: async () => { throw new Error("boom") } }))
    const r = await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } })
    expect(refusedCode(r)).toBe("card_error")
    expect(createDraftMock.fn).not.toHaveBeenCalled()
  })

  it("refuses card_error when the entry has no card()", async () => {
    entries.map.set("x", entry({ id: "x", card: undefined }))
    expect(refusedCode(await prepareAdminRouteCall(db, ctx, "x", { body: { text: "a" } }))).toBe("card_error")
  })
})
