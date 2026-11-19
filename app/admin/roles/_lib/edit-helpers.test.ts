import { describe, it, expect } from "vitest"
import {
  cellState, dirtyChanges, belowCostIds, canSavePrices, buildPricesPut, marginOf,
  bulkPublicPreview, bulkRolePreview, sourceMapFrom, type PriceRow,
} from "./prices-grid"
import { rateChanges, rateDirtyCount, canSaveRates } from "./rates-edit"
import { capsDirty, toggleCap, rightsConfirmText, sameSet } from "./rights-edit"
import { moveTargets, chunk, addTally, emptyTally, collectAllIds, MAX_SELECT } from "./members-move"
import type { HubRole } from "./ladder-view"

const row = (id: string, over: Partial<PriceRow> = {}): PriceRow => ({
  id, network: "MTN", name: id, price: 10, cost_price: 6, role_price: null, effective_price: 10, is_available: true, ...over,
})

describe("price cell diff", () => {
  it("untouched and unchanged cells are not dirty", () => {
    expect(cellState(row("a"), undefined)).toEqual({ kind: "same" })
    expect(cellState(row("a", { role_price: 8 }), "8")).toEqual({ kind: "same" })
    expect(cellState(row("a", { role_price: 8 }), "8.00")).toEqual({ kind: "same" })
  })
  it("blank means the ladder: null only when the cell had a role price", () => {
    expect(cellState(row("a"), "")).toEqual({ kind: "same" })
    expect(cellState(row("a", { role_price: 8 }), " ")).toEqual({ kind: "clear" })
  })
  it("a changed number is a set, rounded to 2dp", () => {
    expect(cellState(row("a"), "7.456")).toEqual({ kind: "set", price: 7.46 })
  })
  it("junk, zero and negatives are invalid", () => {
    for (const t of ["abc", "0", "-3", "1e999", "0.001"]) expect(cellState(row("a"), t).kind).toBe("invalid")
  })
  it("dirtyChanges sends only edited cells", () => {
    const rows = [row("a"), row("b", { role_price: 8 }), row("c")]
    const r = dirtyChanges(rows, { a: "9", b: "8", c: "" })
    expect(r.changes).toEqual([{ package_id: "a", price: 9 }])
    expect(r.invalid).toEqual([])
  })
  it("dirtyChanges reports invalid ids and clears", () => {
    const rows = [row("a", { role_price: 8 }), row("b")]
    const r = dirtyChanges(rows, { a: "", b: "x" })
    expect(r.changes).toEqual([{ package_id: "a", price: null }])
    expect(r.invalid).toEqual(["b"])
  })
})

describe("below cost", () => {
  it("flags dirty rows whose rounded price is under a known cost", () => {
    const rows = [row("a", { cost_price: 6 }), row("b", { cost_price: null }), row("c", { cost_price: 6 })]
    expect(belowCostIds(rows, { a: "5.99", b: "0.5", c: "6" })).toEqual(["a"])
  })
  it("a null cost never counts as below cost and has no margin", () => {
    expect(belowCostIds([row("b", { cost_price: null })], { b: "0.5" })).toEqual([])
    expect(marginOf(row("b", { cost_price: null }), 5)).toBeNull()
    expect(marginOf(row("a", { cost_price: 6 }), 8)).toEqual({ amount: 2, percent: 25 })
  })
  it("save is blocked until the loss box is ticked, the reason is long enough and nothing is invalid", () => {
    const rows = [row("a", { cost_price: 6 })]
    const base = { rows, edits: { a: "5" }, lossOk: false, reason: "fix" }
    expect(canSavePrices(base).ok).toBe(false)
    expect(canSavePrices({ ...base, lossOk: true }).ok).toBe(true)
    expect(canSavePrices({ ...base, lossOk: true, reason: "no" }).ok).toBe(false)
    expect(canSavePrices({ ...base, edits: {}, lossOk: true }).ok).toBe(false)
    expect(canSavePrices({ ...base, edits: { a: "zz" }, lossOk: true }).ok).toBe(false)
  })
  it("PUT body holds only dirty cells; loss_override only when a row is really below cost", () => {
    const rows = [row("a"), row("b")]
    expect(buildPricesPut(rows, { a: "9" }, true, " why ")).toEqual({
      changes: [{ package_id: "a", price: 9 }], loss_override: false, reason: "why",
    })
    expect(buildPricesPut(rows, { a: "2" }, true, "why").loss_override).toBe(true)
  })
})

describe("bulk helpers never throw", () => {
  const rows = [row("a", { price: 10 }), row("b", { price: 20 })]
  it("public minus percent fills a preview", () => {
    const r = bulkPublicPreview(rows, "10")
    expect(r).toEqual({ ok: true, edits: { a: "9", b: "18" }, skipped: 0 })
  })
  it("rejects out-of-range, blank and non-finite percent", () => {
    for (const t of ["", "abc", "-1", "101", "Infinity", "NaN"]) expect(bulkPublicPreview(rows, t).ok).toBe(false)
  })
  it("copy from role uses role_price then effective_price and adds the delta", () => {
    const src = sourceMapFrom([row("a", { role_price: 7, effective_price: 9 }), row("b", { role_price: null, effective_price: 12 })])
    expect(src.usedRolePrice).toBe(1)
    expect(src.usedEffective).toBe(1)
    expect(bulkRolePreview(src.map, rows, "-1")).toEqual({ ok: true, edits: { a: "6", b: "11" }, skipped: 0 })
  })
  it("rejects a non-finite delta and skips results at or below zero", () => {
    const src = sourceMapFrom([row("a", { role_price: 1 })])
    for (const t of ["", "x", "Infinity"]) expect(bulkRolePreview(src.map, rows, t).ok).toBe(false)
    expect(bulkRolePreview(src.map, rows, "-5")).toEqual({ ok: true, edits: {}, skipped: 1 })
  })
  it("copy only touches packages in the current grid", () => {
    const src = sourceMapFrom([row("zzz", { role_price: 5 })])
    expect(bulkRolePreview(src.map, rows, "0")).toEqual({ ok: true, edits: {}, skipped: 0 })
  })
})

describe("service rates", () => {
  const rates = [
    { service_key: "airtime_fee:mtn", label: "x", value: 2 as number | null, effective: 3 },
    { service_key: "cashback_share:bills", label: "y", value: null as number | null, effective: 1 },
  ]
  it("only dirty keys are sent; blank clears an existing value only", () => {
    const r = rateChanges(rates, { "airtime_fee:mtn": "", "cashback_share:bills": "" })
    expect(r).toEqual({ ok: true, changes: [{ service_key: "airtime_fee:mtn", value: null }] })
    expect(rateDirtyCount(rates, { "airtime_fee:mtn": "2" })).toBe(0)
  })
  it("rejects values outside 0-100 or non-numeric", () => {
    expect(rateChanges(rates, { "airtime_fee:mtn": "101" }).ok).toBe(false)
    expect(rateChanges(rates, { "airtime_fee:mtn": "-1" }).ok).toBe(false)
    expect(rateChanges(rates, { "airtime_fee:mtn": "abc" }).ok).toBe(false)
  })
  it("save needs a dirty valid cell and a reason", () => {
    expect(canSaveRates(rates, { "cashback_share:bills": "5" }, "ok?").ok).toBe(true)
    expect(canSaveRates(rates, { "cashback_share:bills": "5" }, "").ok).toBe(false)
    expect(canSaveRates(rates, {}, "reason").ok).toBe(false)
  })
})

describe("rights", () => {
  it("dirty is set inequality, order independent", () => {
    expect(sameSet(["buy.data", "buy.bills"], ["buy.bills", "buy.data"])).toBe(true)
    expect(capsDirty(["buy.data"], ["buy.data", "buy.bills"])).toBe(true)
  })
  it("toggle adds and removes", () => {
    expect(toggleCap(["buy.data"], "buy.bills", true).sort()).toEqual(["buy.bills", "buy.data"])
    expect(toggleCap(["buy.data"], "buy.data", false)).toEqual([])
  })
  it("confirm text names the member count and flags an empty set", () => {
    expect(rightsConfirmText(12, 3)).toBe("This changes what 12 members can do.")
    expect(rightsConfirmText(1, 3)).toBe("This changes what 1 member can do.")
    expect(rightsConfirmText(5, 0)).toContain("removes every right")
  })
})

describe("members", () => {
  const mk = (slug: string, over: Partial<HubRole> = {}): HubRole => ({
    id: `id-${slug}`, slug, name: slug, description: null, badge_color: "navy", icon: "Star", rank: 1, is_system: false,
    archived_at: null, theme: null, member_count: 0, priced_count: 0, ...over,
  })
  const roles = [
    mk("admin", { is_system: true }), mk("dealer", { is_system: true }), mk("user", { is_system: true }),
    mk("sub_agent", { is_system: true, rank: null }), mk("gold"), mk("old", { archived_at: "2026-01-01" }),
  ]
  it("targets: user, dealer and live custom roles; never admin, sub_agent, archived or current", () => {
    expect(moveTargets(roles, "id-gold").map((r) => r.slug).sort()).toEqual(["dealer", "user"])
    expect(moveTargets(roles, "id-user").map((r) => r.slug).sort()).toEqual(["dealer", "gold"])
  })
  it("chunks ids in 200s", () => {
    const ids = Array.from({ length: 450 }, (_, i) => String(i))
    expect(chunk(ids, 200).map((c) => c.length)).toEqual([200, 200, 50])
  })
  it("tally accumulates moved, skipped and errors", () => {
    const t = addTally(emptyTally(), [
      { user_id: "1", status: "moved" }, { user_id: "2", status: "skipped" }, { user_id: "3", status: "error" }, { user_id: "4", status: "moved" },
    ])
    expect(t).toEqual({ moved: 2, skipped: 1, errors: 1 })
  })
  it("collectAllIds walks pages and stops at the cap with a flag", async () => {
    const pages: Record<number, string[]> = { 1: ["a", "b"], 2: ["c"] }
    const ok = await collectAllIds(async (p) => ({ ids: pages[p] ?? [], total: 3 }), 50)
    expect(ok).toEqual({ ids: ["a", "b", "c"], capped: false })
    const capped = await collectAllIds(async (p) => ({ ids: [`${p}x`, `${p}y`], total: 99999 }), 50, 4)
    expect(capped.capped).toBe(true)
    expect(capped.ids.length).toBe(4)
    expect(MAX_SELECT).toBe(5000)
  })
})
