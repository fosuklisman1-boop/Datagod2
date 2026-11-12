import { describe, it, expect } from "vitest"
import { BULK_MAX_USERS, bulkConfirmTitle, parseBulkRequest, parseMatchingFilters, summariseBulkResults } from "./bulk-params"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i + 1))
const errs = (b: unknown) => { const r = parseBulkRequest(b); if (r.ok) throw new Error("expected errors"); return r.errors }

describe("parseBulkRequest", () => {
  it("set_role: user / dealer / admin only", () => {
    expect(parseBulkRequest({ action: "set_role", userIds: [id(1)], params: { role: "Dealer" } }))
      .toEqual({ ok: true, request: { action: "set_role", target: { kind: "ids", ids: [id(1)] }, role: "dealer" } })
    expect(errs({ action: "set_role", userIds: [id(1)], params: { role: "sub_agent" } })).toEqual(["params.role must be one of: user, dealer, admin"])
    expect(errs({ action: "set_role", userIds: [id(1)] })).toHaveLength(1)
  })

  it("suspend needs a reason; unsuspend does not", () => {
    expect(errs({ action: "suspend", userIds: [id(1)], params: {} })[0]).toMatch(/reason is required/)
    expect(errs({ action: "suspend", userIds: [id(1)], params: { reason: " x " } })[0]).toMatch(/reason is required/)
    expect(errs({ action: "suspend", userIds: [id(1)], params: { reason: "x".repeat(501) } })[0]).toMatch(/at most 500/)
    expect(parseBulkRequest({ action: "suspend", userIds: [id(1)], params: { reason: "  chargebacks " } }))
      .toMatchObject({ ok: true, request: { reason: "chargebacks" } })
    expect(parseBulkRequest({ action: "unsuspend", userIds: [id(1)] })).toMatchObject({ ok: true, request: { reason: null } })
  })

  it("userIds: 1..200 UUIDs, de-duplicated case-insensitively", () => {
    expect(errs({ action: "unsuspend", userIds: [] })).toEqual(["userIds must be a non-empty array"])
    expect(errs({ action: "unsuspend", userIds: "x" })).toEqual(["userIds must be a non-empty array"])
    expect(errs({ action: "unsuspend", userIds: [id(1), "nope", 5] })).toEqual(["userIds must be user ids (2 invalid)"])
    expect(errs({ action: "unsuspend", userIds: ids(BULK_MAX_USERS + 1) })).toEqual(["At most 200 users per bulk action"])
    const r = parseBulkRequest({ action: "unsuspend", userIds: [...ids(BULK_MAX_USERS)] })
    expect(r.ok && r.request.target.kind === "ids" && r.request.target.ids.length).toBe(200)
    const d = parseBulkRequest({ action: "unsuspend", userIds: [id(1), id(1).toUpperCase()] })
    expect(d.ok && d.request.target.kind === "ids" && d.request.target.ids).toEqual([id(1)])
  })

  it("matching (every user matching the filters) only for notify, and not together with userIds", () => {
    expect(errs({ action: "suspend", matching: { role: "dealer" }, params: { reason: "abc" } })[0]).toMatch(/only allowed for notifications/)
    expect(errs({ action: "set_role", matching: {}, params: { role: "user" } })[0]).toMatch(/only allowed for notifications/)
    expect(errs({ action: "notify", matching: {}, userIds: [id(1)], params: { title: "t", message: "m", channels: ["push"] } })[0]).toMatch(/not both/)
    expect(parseBulkRequest({ action: "notify", matching: { role: "dealer", tag: "VIP", suspended: false, sort: "email", dir: "asc" }, params: { title: "t", message: "m", channels: ["push"] } }))
      .toMatchObject({ ok: true, request: { target: { kind: "matching", filters: { role: "dealer", tag: "vip", suspended: false, q: null } } } })
  })

  it("notify: title, message, channels within the broadcast limits", () => {
    const ok = parseBulkRequest({ action: "notify", userIds: [id(1)], params: { title: " Hi ", message: " Hello ", channels: ["sms", "in_app", "sms"] } })
    expect(ok).toEqual({ ok: true, request: { action: "notify", target: { kind: "ids", ids: [id(1)] }, title: "Hi", message: "Hello", channels: ["in_app", "sms"] } })
    expect(errs({ action: "notify", userIds: [id(1)], params: { title: "", message: "m", channels: ["push"] } })).toEqual(["params.title is required"])
    expect(errs({ action: "notify", userIds: [id(1)], params: { title: "x".repeat(201), message: "m", channels: ["push"] } })[0]).toMatch(/at most 200/)
    expect(errs({ action: "notify", userIds: [id(1)], params: { title: "t", message: "x".repeat(5001), channels: ["push"] } })[0]).toMatch(/at most 5000/)
    expect(errs({ action: "notify", userIds: [id(1)], params: { title: "t", message: "m", channels: [] } })[0]).toMatch(/at least one/)
    expect(errs({ action: "notify", userIds: [id(1)], params: { title: "t", message: "m", channels: ["email"] } })[0]).toMatch(/may only contain/)
  })

  it("rejects unknown actions and non-objects", () => {
    expect(errs({ action: "delete", userIds: [id(1)] })[0]).toMatch(/action must be one of/)
    expect(errs(null)).toEqual(["Body must be a JSON object"])
    expect(errs([])).toEqual(["Body must be a JSON object"])
  })
})

describe("parseMatchingFilters", () => {
  it("validates like the list query string", () => {
    expect(parseMatchingFilters({ role: "root" })).toMatchObject({ ok: false })
    expect(parseMatchingFilters({ password: "x" })).toEqual({ ok: false, errors: ["matching.password is not a filter"] })
    expect(parseMatchingFilters({ from: "2026-01-01", to: "2026-01-31", q: null })).toMatchObject({ ok: true, filters: { from: "2026-01-01", to: "2026-01-31", q: null } })
    expect(parseMatchingFilters(null).ok).toBe(false)
  })
})

describe("bulkConfirmTitle / summariseBulkResults", () => {
  it("asks with the count", () => {
    expect(bulkConfirmTitle("suspend", 37)).toBe("Suspend 37 users?")
    expect(bulkConfirmTitle("unsuspend", 1)).toBe("Unsuspend 1 user?")
    expect(bulkConfirmTitle("set_role", 2, "dealer")).toBe("Change 2 users to Dealer?")
    expect(bulkConfirmTitle("notify", 1200)).toBe("Send a notification to 1,200 users?")
  })
  it("groups failures by message", () => {
    expect(summariseBulkResults([
      { id: "a", ok: true }, { id: "b", ok: true, note: "unchanged" },
      { id: "c", ok: false, error: "User not found" }, { id: "d", ok: false, error: "x" }, { id: "e", ok: false, error: "User not found" },
    ])).toEqual({
      total: 5, succeeded: 2, failed: 3, unchanged: 1,
      errors: [{ error: "User not found", ids: ["c", "e"] }, { error: "x", ids: ["d"] }],
      notes: [],
    })
  })
  it("lists partial-channel notes of successful users (not 'unchanged')", () => {
    expect(summariseBulkResults([
      { id: "a", ok: true, note: "Push/SMS not queued (down)" }, { id: "b", ok: true, note: "Push/SMS not queued (down)" },
      { id: "c", ok: true, note: "unchanged" },
    ]).notes).toEqual([{ note: "Push/SMS not queued (down)", ids: ["a", "b"] }])
  })
})

describe("bulkTargetCount", () => {
  it("leaves the acting admin out of role and suspension counts (the server skips them), not out of notify", async () => {
    const { bulkTargetCount } = await import("./bulk-params")
    const sel = new Set([id(1), id(2), id(3)])
    expect(bulkTargetCount("suspend", sel, id(2))).toEqual({ count: 2, selfSkipped: true })
    expect(bulkTargetCount("set_role", sel, id(2).toUpperCase())).toEqual({ count: 2, selfSkipped: true })
    expect(bulkTargetCount("unsuspend", sel, id(9))).toEqual({ count: 3, selfSkipped: false })
    expect(bulkTargetCount("notify", sel, id(2))).toEqual({ count: 3, selfSkipped: false })
    expect(bulkTargetCount("suspend", sel, null)).toEqual({ count: 3, selfSkipped: false })
  })
})
