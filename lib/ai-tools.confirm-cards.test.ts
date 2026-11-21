import { describe, it, expect, vi, beforeEach } from "vitest"

const prep = vi.hoisted(() => ({
  prepareWalletOrder: vi.fn(),
  prepareWalletAdjustment: vi.fn(),
  prepareWithdrawalAction: vi.fn(),
  prepareUserSuspension: vi.fn(),
  prepareRoleChange: vi.fn(),
  prepareBulkStatusUpdate: vi.fn(),
}))
vi.mock("@/lib/ai-drafts/prepare-wallet-order", () => ({ prepareWalletOrder: prep.prepareWalletOrder }))
vi.mock("@/lib/ai-drafts/prepare-admin", () => ({
  prepareWalletAdjustment: prep.prepareWalletAdjustment,
  prepareWithdrawalAction: prep.prepareWithdrawalAction,
  prepareUserSuspension: prep.prepareUserSuspension,
  prepareRoleChange: prep.prepareRoleChange,
  prepareBulkStatusUpdate: prep.prepareBulkStatusUpdate,
}))

import { aiTools, executeToolCall, type AIChatContext } from "@/lib/ai-tools"

const FORBIDDEN = [
  "place_wallet_order",
  "adjust_wallet_balance",
  "manage_withdrawal",
  "suspend_user",
  "update_user_role",
  "bulk_update_order_status",
]
const ALL_CONTEXTS: AIChatContext[] = ["home", "storefront", "dashboard", "admin", "whatsapp", "whatsapp_shop"]
const names = (c: AIChatContext) => aiTools(c).map(t => t.name)

const CK = "11111111-1111-4111-8111-111111111111"
const DRAFT = { draft_id: "d1", display: {}, expires_at: "2026-11-21T00:00:00Z", warnings: [] }

beforeEach(() => {
  vi.resetAllMocks()
  for (const f of Object.values(prep)) f.mockResolvedValue(DRAFT)
})

describe("forbidden_tools_absent", () => {
  it.each(ALL_CONTEXTS)("none of the six direct tools is offered in %s", ctx => {
    for (const n of FORBIDDEN) expect(names(ctx)).not.toContain(n)
  })
})

describe("prepare_tools_present", () => {
  it("dashboard gets prepare_wallet_order only", () => {
    const n = names("dashboard")
    expect(n).toContain("prepare_wallet_order")
    for (const a of ["prepare_wallet_adjustment", "prepare_withdrawal_action", "prepare_user_suspension", "prepare_role_change", "prepare_bulk_status_update"]) {
      expect(n).not.toContain(a)
    }
  })
  it("admin gets the five admin prepare tools and no wallet order tool", () => {
    const n = names("admin")
    for (const a of ["prepare_wallet_adjustment", "prepare_withdrawal_action", "prepare_user_suspension", "prepare_role_change", "prepare_bulk_status_update"]) {
      expect(n).toContain(a)
    }
    expect(n).not.toContain("prepare_wallet_order")
  })
})

describe("shop_and_home_have_no_prepare_wallet_order", () => {
  it.each(["home", "storefront", "whatsapp", "whatsapp_shop"] as AIChatContext[])("%s has no prepare_* tool", ctx => {
    expect(names(ctx).filter(n => n.startsWith("prepare_") && n !== "prepare_checkout")).toEqual([])
  })
})

describe("scheduled task descriptions", () => {
  const SENTENCE = "Scheduled tasks cannot place orders or perform admin actions on their own. For a recurring data order use prepare_wallet_order with schedule; admin tasks can only prepare cards for you to confirm."
  it("schedule_task and manage_scheduled_task carry the sentence", () => {
    const dash = aiTools("dashboard").find(t => t.name === "schedule_task")!
    const adm = aiTools("admin").find(t => t.name === "manage_scheduled_task")!
    expect(dash.description).toContain(SENTENCE)
    expect(adm.description).toContain(SENTENCE)
  })
})

describe("prepare_* dispatch", () => {
  const dashCtx = { baseUrl: "http://x", jwtToken: "t", userId: "u1", userRole: "dealer", conversationKey: CK } as any
  const adminCtx = { baseUrl: "http://x", jwtToken: "t", userId: "a1", userRole: "admin", conversationKey: CK } as any

  it("prepare_wallet_order uses the server-side user, DB role and conversation key, and maps schedule to camelCase", async () => {
    const r = await executeToolCall("prepare_wallet_order", {
      network: "MTN", size: "5", phone_number: "0241234567",
      schedule: { type: "weekly", run_at_time: "18:00", run_on_days: [1], run_at_timestamp: "2026-12-01T00:00:00Z" },
    }, dashCtx)
    expect(r).toEqual(DRAFT)
    const [, ctx, input] = prep.prepareWalletOrder.mock.calls[0]
    expect(ctx).toEqual({ userId: "u1", userRole: "dealer", conversationKey: CK })
    expect(input).toEqual({
      network: "MTN", size: "5", phone_number: "0241234567",
      schedule: { type: "weekly", runAtTime: "18:00", runOnDays: [1], runAtTimestamp: "2026-12-01T00:00:00Z" },
    })
  })

  it("prepare_wallet_order without a signed-in user is refused and prepares nothing", async () => {
    const r = await executeToolCall("prepare_wallet_order", { network: "MTN", size: "1", phone_number: "0241234567" }, { baseUrl: "http://x" } as any)
    expect(r).toMatchObject({ refused: true })
    expect(prep.prepareWalletOrder).not.toHaveBeenCalled()
  })

  it("a null conversation key is passed through when the request had none", async () => {
    await executeToolCall("prepare_wallet_order", { network: "MTN", size: "1", phone_number: "0241234567" }, { ...dashCtx, conversationKey: undefined })
    expect(prep.prepareWalletOrder.mock.calls[0][1].conversationKey).toBeNull()
  })

  it("admin prepare tools pass adminId, conversationKey and background", async () => {
    await executeToolCall("prepare_wallet_adjustment", { user_id: "u9", type: "credit", amount: 5, reason: "Refund DG-1" }, { ...adminCtx, background: true })
    expect(prep.prepareWalletAdjustment.mock.calls[0][1]).toEqual({ adminId: "a1", conversationKey: CK, background: true })
    expect(prep.prepareWalletAdjustment.mock.calls[0][2]).toEqual({ user_id: "u9", type: "credit", amount: 5, reason: "Refund DG-1" })

    await executeToolCall("prepare_withdrawal_action", { action: "approve", withdrawal_ids: ["w1", "w2"] }, adminCtx)
    expect(prep.prepareWithdrawalAction.mock.calls[0][2]).toMatchObject({ action: "approve", withdrawal_ids: ["w1", "w2"] })

    await executeToolCall("prepare_user_suspension", { user_id: "u9", suspend: true }, adminCtx)
    expect(prep.prepareUserSuspension.mock.calls[0][2]).toEqual({ user_id: "u9", suspend: true })

    await executeToolCall("prepare_role_change", { user_id: "u9", role: "dealer" }, adminCtx)
    expect(prep.prepareRoleChange.mock.calls[0][2]).toEqual({ user_id: "u9", role: "dealer" })

    await executeToolCall("prepare_bulk_status_update", { status: "completed", filter_status: "pending", filter_network: "MTN" }, adminCtx)
    expect(prep.prepareBulkStatusUpdate.mock.calls[0][2]).toEqual({ status: "completed", filters: { filter_status: "pending", filter_network: "MTN" } })
  })

  it("admin prepare tools refuse a non-admin caller and never reach the builder", async () => {
    for (const n of ["prepare_wallet_adjustment", "prepare_withdrawal_action", "prepare_user_suspension", "prepare_role_change", "prepare_bulk_status_update"]) {
      const r = await executeToolCall(n, {}, { ...dashCtx })
      expect(r).toEqual({ error: "Not authorized" })
    }
    expect(prep.prepareWalletAdjustment).not.toHaveBeenCalled()
    expect(prep.prepareBulkStatusUpdate).not.toHaveBeenCalled()
  })

  it("the removed tools are no longer dispatchable", async () => {
    for (const n of FORBIDDEN) {
      const r = await executeToolCall(n, {}, adminCtx) as Record<string, unknown>
      expect(r.error).toBeTruthy()
    }
  })
})

describe("prepare_wallet_order schedule enum", () => {
  it("offers exactly once, daily, weekly", () => {
    const t: any = aiTools("dashboard").find((x) => x.name === "prepare_wallet_order")
    expect(t.input_schema.properties.schedule.properties.type.enum).toEqual(["once", "daily", "weekly"])
  })
})
