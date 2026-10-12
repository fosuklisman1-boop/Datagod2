import { readFileSync } from "node:fs"
import path from "node:path"

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8").replace(/\r\n/g, "\n")

describe("withdrawals wiring", () => {
  it("create route alerts admins once", () => {
    const src = read("app/api/user/withdrawals/create/route.ts")
    expect(src.match(/alertAdminsOfRequest\("withdrawal"/g)).toHaveLength(1)
  })
  it("approve route notifies via the central notifier and no longer sends inline email/sms for approval", () => {
    const src = read("app/api/admin/withdrawals/approve/route.ts")
    expect(src).toContain('notifyUserOfOutcome("withdrawal", "approved"')
    expect(src).not.toContain("type: 'withdrawal_approved'")
    expect(src).not.toContain("notificationTemplates.withdrawalApproved")
  })
  it("bulk-approve success path uses the central notifier", () => {
    const src = read("app/api/admin/withdrawals/bulk-approve/route.ts")
    expect(src).toContain('notifyUserOfOutcome("withdrawal", "approved"')
  })
  it("reject route uses the central notifier and a conditional update", () => {
    const src = read("app/api/admin/withdrawals/reject/route.ts")
    expect(src).toContain('notifyUserOfOutcome("withdrawal", "rejected"')
    expect(src).not.toContain("type: 'withdrawal_rejected'")
    expect(src).not.toContain("notificationTemplates.withdrawalRejected")
    expect(src).toMatch(/\.in\("status", rejectableStatuses\)/)
  })
  it("complete route, transfer-otp route, status cron and paystack webhook notify 'completed' via the shared hook", () => {
    for (const f of [
      "app/api/admin/withdrawals/complete/route.ts",
      "app/api/admin/withdrawals/submit-transfer-otp/route.ts",
      "app/api/cron/withdrawals-status-check/route.ts",
      "app/api/webhooks/paystack/route.ts",
    ]) {
      expect(read(f)).toContain("notifyWithdrawalCompleted(")
    }
    expect(read("lib/admin-actions/withdrawal-hook.ts")).toContain('notifyUserOfOutcome("withdrawal", "completed"')
  })
  it("instant payouts (approve + bulk-approve) send 'completed', manual approvals send 'approved'", () => {
    const count = (src: string, needle: string) => src.split(needle).length - 1
    const approve = read("app/api/admin/withdrawals/approve/route.ts")
    expect(count(approve, "notifyWithdrawalCompleted(supabase, withdrawal)")).toBe(2)
    expect(count(approve, "await notifyShopOwner(withdrawal, withdrawalId)")).toBe(3)
    const bulk = read("app/api/admin/withdrawals/bulk-approve/route.ts")
    expect(count(bulk, "notifyWithdrawalCompleted(supabase, locked)")).toBe(2)
    expect(count(bulk, '.eq("status", "processing")')).toBeGreaterThanOrEqual(2)
  })
  it("bulk-approve collects notifies and awaits them once with allSettled", () => {
    const bulk = read("app/api/admin/withdrawals/bulk-approve/route.ts")
    expect(bulk).toContain("Promise.allSettled(pendingNotifies)")
    expect(bulk).not.toContain("await notifyOwner(")
    expect(bulk).not.toContain("await notifyWithdrawalCompleted(")
  })
  it("cron and otp routes no longer send their own inline completion messages", () => {
    for (const f of ["app/api/admin/withdrawals/submit-transfer-otp/route.ts", "app/api/cron/withdrawals-status-check/route.ts"]) {
      expect(read(f)).not.toContain("notificationTemplates.withdrawalApproved")
    }
  })
})

describe("shop approvals wiring", () => {
  it("create route alerts admins once", () => {
    expect(read("app/api/shop/create/route.ts").match(/alertAdminsOfRequest\("shop"/g)).toHaveLength(1)
  })
  it("approve and reject use the central notifier, not inline sends", () => {
    const a = read("app/api/admin/shops/approve/route.ts")
    expect(a).toContain('notifyUserOfOutcome("shop", "approved"')
    expect(a).not.toContain("type: 'shop_approved'")
    expect(a).toContain('.eq("is_active", false)')
    const r = read("app/api/admin/shops/reject/route.ts")
    expect(r).toContain('notifyUserOfOutcome("shop", "rejected"')
    expect(r).not.toContain("type: 'shop_rejected'")
  })
})

describe("afa wiring", () => {
  it("creation alerts admins once, only when not auto-fulfilling", () => {
    const src = read("lib/afa-fulfillment.ts")
    expect(src.match(/alertAdminsOfRequest\("afa"/g)).toHaveLength(1)
    expect(src).toMatch(/if \(!autoFulfill\) \{\s*await alertAdminsForManualAfa\(/)
  })
  it("failed provider attempts that leave the order for an admin alert via the shared helper", () => {
    const src = read("lib/afa-fulfillment.ts")
    expect(src.match(/await alertAdminsForManualAfa\(/g)!.length).toBe(4)
  })
  it("admin status route uses the central notifier", () => {
    const src = read("app/api/admin/afa-update-status/route.ts")
    expect(src).toMatch(/notifyUserOfOutcome\(\s*"afa"/)
    expect(src).not.toContain("SMSTemplates.afaCompleted")
    expect(src).not.toContain("sendSMS")
  })
  it("fulfilment success notifies completed, conditionally", () => {
    const src = read("lib/afa-fulfillment.ts")
    expect(src).toMatch(/notifyUserOfOutcome\(\s*"afa",\s*"completed"/)
    expect(src).toContain('.neq("status", "completed")')
  })
})

describe("afa apexprime cron wiring", () => {
  const src = () => read("app/api/cron/sync-afa-status/apexprime/route.ts")
  it("notifies completed once, conditionally, afa_orders only", () => {
    expect(src().match(/notifyUserOfOutcome\(\s*"afa",\s*"completed"/g)).toHaveLength(1)
    expect(src()).toContain('.neq(statusCol, "completed")')
    expect(src().match(/table === "afa_orders" &&/g)!.length).toBe(3)
  })
  it("alerts admins at both async failure branches", () => {
    expect(src().match(/alertAdminsOfRequest\("afa"/g)).toHaveLength(2)
  })
})
