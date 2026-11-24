import { describe, expect, it } from "vitest"
import { draftCardView, formatGhanaTime, linkedCardState, type CardViewState } from "./draft-card-view"

const NOW = Date.parse("2026-11-21T10:00:00Z")
const display = {
  title: "Confirm data order",
  lines: [
    { label: "Price", value: "GHS 23.50" },
    { label: "Balance after", value: "GHS 96.50" },
  ],
}
const base = (over: Partial<CardViewState> = {}): CardViewState => ({
  status: "pending",
  outcome: null,
  display,
  expires_at: new Date(NOW + 9 * 60_000 + 41_000).toISOString(),
  warnings: [],
  ...over,
})
const view = (over: Partial<CardViewState> = {}, now = NOW) => draftCardView(base(over), now)

describe("draftCardView", () => {
  it("pending_shows_confirm", () => {
    const v = view()
    expect(v.variant).toBe("pending")
    expect(v.showConfirm).toBe(true)
    expect(v.showCancel).toBe(true)
    expect(v.title).toBe("Confirm data order")
    expect(v.lines).toEqual(expect.arrayContaining([{ label: "Price", value: "GHS 23.50" }]))
    expect(v.countdownText).toBe("Expires in 9:41")
    expect(v.greyed).toBe(false)
  })

  it("pending past its expiry renders the expired view", () => {
    const v = view({}, NOW + 10 * 60_000)
    expect(v.variant).toBe("expired")
    expect(v.showConfirm).toBe(false)
    expect(v.showPrepareAgain).toBe(true)
    expect(v.greyed).toBe(true)
  })

  it("confirm_disables_buttons_while_request_in_flight: executing hides every action", () => {
    const v = view({ status: "executing" })
    expect(v.variant).toBe("executing")
    expect(v.showConfirm).toBe(false)
    expect(v.showCancel).toBe(false)
    expect(v.showCheckAgain).toBe(false)
    expect(v.countdownText).toBeNull()
  })

  it("succeeded_hides_confirm_after_reload", () => {
    const v = view({ status: "already_done", finalStatus: "succeeded", outcome: { order_code: "ORD-1", new_balance: 96.5 } })
    expect(v.variant).toBe("succeeded")
    expect(v.showConfirm).toBe(false)
    expect(v.showCancel).toBe(false)
    expect(v.lines).toEqual(expect.arrayContaining([{ label: "Order", value: "ORD-1" }, { label: "New balance", value: "GHS 96.50" }]))
    expect(v.message).toMatch(/already/i)
    expect(v.countdownText).toBeNull()
  })

  it("a first-tap succeeded shows the result without the replay wording", () => {
    const v = view({ status: "succeeded", outcome: { order_code: "ORD-2" } })
    expect(v.variant).toBe("succeeded")
    expect(v.message).not.toMatch(/already/i)
    expect(v.showConfirm).toBe(false)
  })

  it("unknown_shows_check_again", () => {
    const v = view({ status: "unknown", outcome: { code: "no_response", message: "We couldn't confirm the result." } })
    expect(v.variant).toBe("unknown")
    expect(v.showCheckAgain).toBe(true)
    expect(v.showConfirm).toBe(false)
    expect(v.message).toBe("We couldn't confirm the result.")
  })

  it("superseded_greyed", () => {
    const v = view({ status: "superseded" })
    expect(v.greyed).toBe(true)
    expect(v.showConfirm).toBe(false)
    expect(v.showCancel).toBe(false)
    expect(v.message).toBe("Replaced by a newer card")
  })

  it("cancelled and expired are greyed", () => {
    expect(view({ status: "cancelled" }).greyed).toBe(true)
    const e = view({ status: "expired" })
    expect(e.greyed).toBe(true)
    expect(e.showPrepareAgain).toBe(true)
  })

  it("insufficient_balance links to the wallet top-up page", () => {
    const v = view({ status: "failed", outcome: { code: "insufficient_balance" } })
    expect(v.variant).toBe("failed")
    expect(v.message).toMatch(/balance/i)
    expect(v.topUpHref).toBe("/dashboard/wallet")
  })

  it("price_changed shows old to new and Prepare again", () => {
    const v = view({ status: "failed", outcome: { code: "price_changed", oldPrice: 23.5, newPrice: 25 } })
    expect(v.message).toContain("GHS 23.50")
    expect(v.message).toContain("GHS 25.00")
    expect(v.showPrepareAgain).toBe(true)
  })

  it("schedule_not_supported", () => {
    const v = view({ status: "failed", outcome: { code: "schedule_not_supported" } })
    expect(v.message).toMatch(/schedul/i)
    expect(v.showConfirm).toBe(false)
  })

  it("scheduled success says it will run, not Done", () => {
    const v = view({ status: "succeeded", outcome: { code: "scheduled", task_id: "t", next_run_at: "2026-11-22T08:00:00.000Z" } })
    expect(v.variant).toBe("succeeded")
    expect(v.message).toMatch(/Scheduled/)
  })

  it("still_checking keeps Check again", () => {
    const v = view({ status: "unknown", outcome: { code: "still_checking" } })
    expect(v.message).toBe("Still checking. Try again in a few minutes.")
    expect(v.showCheckAgain).toBe(true)
  })

  it("interrupted is unknown with Check again", () => {
    const v = view({ status: "unknown", outcome: { code: "interrupted" } })
    expect(v.showCheckAgain).toBe(true)
    expect(v.message).toBe("We couldn't confirm the result.")
  })

  it("not_placed tells the user they were not charged", () => {
    const v = view({ status: "failed", outcome: { code: "not_placed" } })
    expect(v.message).toMatch(/not charged/i)
    expect(v.showPrepareAgain).toBe(true)
  })

  it("not_applied is safe to prepare again", () => {
    const v = view({ status: "failed", outcome: { code: "not_applied" } })
    expect(v.message).toMatch(/not applied/i)
    expect(v.showPrepareAgain).toBe(true)
  })

  it("check_wallet_history", () => {
    const v = view({ status: "unknown", outcome: { code: "check_wallet_history" } })
    expect(v.message).toMatch(/wallet history/i)
    expect(v.showCheckAgain).toBe(true)
  })

  it("admin_required", () => {
    const v = view({ status: "failed", outcome: { code: "admin_required" } })
    expect(v.message).toMatch(/admin/i)
    expect(v.showConfirm).toBe(false)
  })

  it("partial shows N done and M failed with a per-item list", () => {
    const v = view({
      status: "already_done",
      finalStatus: "partial",
      outcome: {
        applied: 2,
        total: 3,
        results: [
          { id: "aaaaaaaa-1111", ok: true },
          { id: "bbbbbbbb-2222", ok: true },
          { id: "cccccccc-3333", ok: false, error: "not_applied" },
        ],
      },
    })
    expect(v.variant).toBe("partial")
    expect(v.message).toBe("2 done · 1 failed")
    expect(v.items).toHaveLength(3)
    expect(v.showConfirm).toBe(false)
  })

  it("partial bulk results list per table", () => {
    const v = view({
      status: "partial",
      outcome: { applied: 3, total: 5, results: [{ table: "orders", count: 3, total: 5 }] },
    })
    expect(v.message).toBe("3 done · 2 failed")
    expect(v.items[0]).toContain("orders")
  })

  it("endpoint_error", () => {
    const v = view({ status: "failed", outcome: { code: "endpoint_error" } })
    expect(v.message).toMatch(/went wrong/i)
  })

  it("rejected and unknown codes fall back to the server message, then a generic line", () => {
    expect(view({ status: "failed", outcome: { code: "rejected", message: "Number is blocked" } }).message).toBe("Number is blocked")
    expect(view({ status: "failed", outcome: { code: "weird" } }).message).toMatch(/could not be completed/i)
  })

  it("an unrecognised unknown outcome still shows Check again", () => {
    const v = view({ status: "unknown", outcome: null })
    expect(v.message).toBe("We couldn't confirm the result.")
    expect(v.showCheckAgain).toBe(true)
  })

  it("renders a once schedule timestamp human-readably (Ghana = UTC)", () => {
    const v = view({
      display: { title: "Confirm scheduled order", lines: [{ label: "Schedule", value: "Once at 2026-11-22T08:00:00.000Z" }] },
    })
    expect(v.lines[0].value).toBe("Once at Sun 22 Nov, 08:00")
    expect(formatGhanaTime("2026-11-22T08:00:00Z")).toBe("Sun 22 Nov, 08:00")
  })

  it("shows warnings on a pending card", () => {
    const v = view({ warnings: ["duplicate_recent"] })
    expect(v.showConfirm).toBe(true)
  })
})

describe("load errors, balance line, replay proof", () => {
  it("load_error_disables_actions", () => {
    for (const loadError of ["unauthorized", "rate_limited", "unavailable", "network", "not_found"] as const) {
      const v = view({ loadError })
      expect(v.showConfirm).toBe(false)
      expect(v.showCancel).toBe(false)
      expect(v.countdownText).toBeNull()
      expect(v.message).toBeTruthy()
    }
    expect(view({ loadError: "unauthorized" }).message).toBe("Please sign in again.")
  })

  it("not_found_has_no_retry", () => {
    const v = view({ loadError: "not_found" })
    expect(v.showRetry).toBe(false)
    expect(v.message).toBe("This card is no longer available.")
    expect(v.greyed).toBe(true)
  })

  it("retry_shown_for_network_error", () => {
    expect(view({ loadError: "network" }).showRetry).toBe(true)
    expect(view({ loadError: "rate_limited" }).showRetry).toBe(true)
    expect(view({ loadError: "unavailable" }).showRetry).toBe(true)
    expect(view().showRetry).toBe(false)
  })

  it("balance_before_after_line", () => {
    const v = view({ display: { title: "t", lines: [{ label: "Price", value: "GHS 23.50" }], balanceBefore: 120, balanceAfter: 96.5 } })
    expect(v.lines).toContainEqual({ label: "Balance", value: "GHS 120.00 → GHS 96.50" })
  })

  it("no_duplicate_balance_line", () => {
    const v = view({
      display: {
        title: "t",
        lines: [{ label: "Price", value: "GHS 23.50" }, { label: "Balance after", value: "GHS 96.50" }, { label: "Balance", value: "x" }],
        balanceBefore: 120,
        balanceAfter: 96.5,
      },
    })
    expect(v.lines.filter((l) => /^balance/i.test(l.label))).toEqual([{ label: "Balance", value: "GHS 120.00 → GHS 96.50" }])
  })

  it("already_done_without_final_status_is_unknown", () => {
    const v = view({ status: "already_done", outcome: { order_code: "ORD-1" } })
    expect(v.variant).toBe("unknown")
    expect(v.showCheckAgain).toBe(true)
    expect(v.message).toBe("We couldn't confirm the result.")
  })
})

describe("linked card initial state", () => {
  const serverOf = (over: Record<string, unknown>) => ({ status: "pending", outcome: null, display, expires_at: new Date(NOW + 60_000).toISOString(), ...over })

  it("linked_card_already_succeeded_shows_done", () => {
    const s = linkedCardState(serverOf({ status: "succeeded", outcome: { order_code: "A1" } }))
    const v = draftCardView(s, NOW)
    expect(v.variant).toBe("succeeded")
    expect(v.showConfirm).toBe(false)
  })

  it("linked_card_expired_no_confirm", () => {
    const v = draftCardView(linkedCardState(serverOf({ status: "expired" })), NOW)
    expect(v.variant).toBe("expired")
    expect(v.showConfirm).toBe(false)
    const cancelled = draftCardView(linkedCardState(serverOf({ status: "cancelled" })), NOW)
    expect(cancelled.showConfirm).toBe(false)
  })
})

describe("state_changed_message", () => {
  it("state_changed_message", () => {
    const v = draftCardView(base({ status: "failed", outcome: { code: "state_changed" } }), NOW)
    expect(v.message).toBe("This changed since the card was made — prepare it again.")
    expect(v.showPrepareAgain).toBe(true)
  })
})

// ---- admin_route cards (Task 7) ----
import { clearsSecrets, adminCardTone, buildConfirmSecrets, confirmErrorMessage, safePageLink, secretsReady } from "./draft-card-view"

const adminDisplay = (over: Record<string, unknown> = {}) => ({
  kind: "admin_route",
  entryId: "users.reset-password",
  page: "/admin/users",
  pageTitle: "Users",
  summary: "Set a new password for Kofi Mensah.",
  lines: [{ label: "User", value: "Kofi Mensah" }],
  risk: "normal",
  secretFields: [],
  ...over,
})
const adminView = (displayOver: Record<string, unknown> = {}, over: Partial<CardViewState> = {}) =>
  view({ display: adminDisplay(displayOver), ...over })

describe("admin_route cards", () => {
  it("renders pageTitle, summary and lines", () => {
    const v = adminView()
    expect(v.title).toBe("Users")
    expect(v.summary).toBe("Set a new password for Kofi Mensah.")
    expect(v.lines).toEqual([{ label: "User", value: "Kofi Mensah" }])
    expect(v.risk).toBe("normal")
    expect(v.dangerNote).toBeNull()
    expect(v.showConfirm).toBe(true)
  })

  it("danger is red with the exact irreversible line", () => {
    const v = adminView({ risk: "danger" })
    expect(v.risk).toBe("danger")
    expect(v.dangerNote).toBe("This cannot be undone.")
    expect(adminCardTone("danger")).toContain("destructive")
  })

  it("money is amber, normal is the navy accent", () => {
    expect(adminView({ risk: "money" }).risk).toBe("money")
    expect(adminCardTone("money")).toContain("amber")
    expect(adminCardTone("normal")).toContain("primary")
  })

  it("tolerates missing or garbled fields without crashing", () => {
    const v = adminView({ pageTitle: 42, summary: null, lines: "nope", risk: "wild", secretFields: [null, { name: 5 }, "x"] })
    expect(v.title).toBe("Confirm action")
    expect(v.summary).toBeNull()
    expect(v.lines).toEqual([])
    expect(v.risk).toBe("normal")
    expect(v.secretFields).toEqual([])
    expect(draftCardView(base({ display: { kind: "admin_route" } }), NOW).variant).toBe("pending")
  })

  it("exposes only well-formed secret fields", () => {
    const v = adminView({ secretFields: [{ name: "password", label: "New password", min: 8, max: 72 }, { name: "", label: "x", min: 1, max: 5 }] })
    expect(v.secretFields).toEqual([{ name: "password", label: "New password", min: 8, max: 72 }])
  })

  it("confirm stays disabled until every secret meets min", () => {
    const f = [{ name: "password", label: "P", min: 8, max: 72 }, { name: "key", label: "K", min: 1, max: 10 }]
    expect(secretsReady(f, {})).toBe(false)
    expect(secretsReady(f, { password: "short", key: "a" })).toBe(false)
    expect(secretsReady(f, { password: "longenough", key: "" })).toBe(false)
    expect(secretsReady(f, { password: "longenough", key: "a" })).toBe(true)
    expect(secretsReady(f, { password: "longenough", key: "a".repeat(11) })).toBe(false)
    expect(secretsReady([], {})).toBe(true)
  })

  it("optional boxes never block Confirm, but a typed value must still fit", () => {
    const f = [{ name: "a", label: "A", min: 8, max: 20, optional: true }, { name: "b", label: "B", min: 1, max: 5 }]
    expect(secretsReady(f, { b: "x" })).toBe(true)
    expect(secretsReady(f, { a: "", b: "x" })).toBe(true)
    expect(secretsReady(f, { a: "short", b: "x" })).toBe(false)
    expect(secretsReady(f, { a: "longenough", b: "" })).toBe(false)
    expect(buildConfirmSecrets(f, { a: "", b: "x" })).toEqual({ secrets: { b: "x" } })
    expect(buildConfirmSecrets(f, { a: "longenough", b: "x" })).toEqual({ secrets: { a: "longenough", b: "x" } })
  })

  it("the confirm payload carries only declared names", () => {
    const f = [{ name: "password", label: "P", min: 1, max: 72 }]
    expect(buildConfirmSecrets(f, { password: "pw1234", injected: "evil" })).toEqual({ secrets: { password: "pw1234" } })
    expect(buildConfirmSecrets([], { injected: "evil" })).toBeNull()
  })

  it("unknown outcome says we could not confirm and links to the page; no recheck button", () => {
    const v = adminView({}, { status: "unknown", outcome: { code: "no_response", pageLink: "/admin/users" } })
    expect(v.message).toBe("We couldn't confirm the result.")
    expect(v.pageLink).toBe("/admin/users")
    expect(v.showCheckAgain).toBe(false)
  })

  it("only /admin links are kept", () => {
    expect(safePageLink("/admin/users?x=1")).toBe("/admin/users?x=1")
    expect(safePageLink("/admin")).toBe("/admin")
    for (const bad of ["https://evil.com", "//evil.com", "/administrator", "/dashboard", "javascript:alert(1)", "/admin\\evil", 5, null, undefined])
      expect(safePageLink(bad)).toBeNull()
    // A bad outcome link is dropped; the entry's own page is used instead.
    const v = adminView({}, { status: "unknown", outcome: { code: "no_response", pageLink: "https://evil.com" } })
    expect(v.pageLink).toBe("/admin/users")
  })

  it("non-admin cards are unchanged", () => {
    const v = view({ status: "unknown", outcome: { code: "no_response" } })
    expect(v.showCheckAgain).toBe(true)
    expect(v.risk).toBeNull()
    expect(v.secretFields).toEqual([])
    expect(v.pageLink).toBeNull()
  })

  it("maps confirm errors to messages that never echo values", () => {
    expect(confirmErrorMessage(400, { code: "missing_secret", error: "Enter the new password." })).toBe("Enter the new password.")
    expect(confirmErrorMessage(400, { code: "bad_secret", error: "Password is too short." })).toBe("Password is too short.")
    expect(confirmErrorMessage(400, { code: "bad_body", error: "Invalid request body" })).toBe("")
    expect(confirmErrorMessage(413, null)).toBe("That value is too long.")
    expect(confirmErrorMessage(400, { code: "missing_secret", error: 5 })).toBe("Please fill in the secure box.")
  })
})

describe("admin card fix round 1", () => {
  it("unknown without an outcome pageLink falls back to the entry's page", () => {
    const v = adminView({ page: "/admin/users" }, { status: "unknown", outcome: { code: "no_response", message: "x" } })
    expect(v.pageLink).toBe("/admin/users")
    expect(adminView({ page: "https://evil.com" }, { status: "unknown", outcome: { code: "no_response" } }).pageLink).toBeNull()
  })

  it("every admin card has a risk badge; other cards none", () => {
    expect(adminView({ risk: "normal" }).riskBadge).toBe("Change")
    expect(adminView({ risk: "money" }).riskBadge).toBe("Money")
    expect(adminView({ risk: "danger" }).riskBadge).toBe("Danger")
    expect(view().riskBadge).toBeNull()
  })

  it("secrets are cleared after confirm and cancel, not after recheck", () => {
    expect(clearsSecrets("confirm")).toBe(true)
    expect(clearsSecrets("cancel")).toBe(true)
    expect(clearsSecrets("recheck")).toBe(false)
  })
})
