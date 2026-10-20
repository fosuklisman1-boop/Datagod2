// The Uzo bot menus gate: Network Plans / Pay Bills show only when the cashback config allows the group on bots
// (enabled && surfaces.bots && botGroups[bundles|bills]) AND the USSD visibility flag is on. Any read error hides
// both (fail closed).
import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { CASHBACK_CONFIG_KEY } from "@/lib/cashback/config"
import { USSD_SERVICE_VISIBILITY_KEY } from "@/lib/ussd-service-visibility"
import { botMenusVisible, uzoBotMenus } from "./gate"

type Rows = Record<string, unknown>

/** admin_settings fake: `.from().select().eq("key", k).maybeSingle()`; a key mapped to an Error fails the read. */
function fakeDb(rows: Rows) {
  const reads: string[] = []
  const db = {
    from(table: string) {
      expect(table).toBe("admin_settings")
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return {
                async maybeSingle() {
                  reads.push(key)
                  const v = rows[key]
                  if (v instanceof Error) return { data: null, error: v }
                  return { data: v === undefined ? null : { value: v }, error: null }
                },
              }
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as SupabaseClient, reads }
}

const cfg = (o: { enabled?: boolean; bots?: boolean; bundles?: boolean; bills?: boolean } = {}) => ({
  enabled: o.enabled ?? true,
  surfaces: { bots: o.bots ?? true },
  botGroups: { bundles: o.bundles ?? true, bills: o.bills ?? true, airtime: true },
})

describe("botMenusVisible: every combination", () => {
  const bools = [true, false]
  for (const enabled of bools) for (const bots of bools) for (const bundles of bools) for (const bills of bools) {
    for (const np of bools) for (const pb of bools) {
      it(`enabled=${enabled} bots=${bots} bundles=${bundles} bills=${bills} | flags np=${np} pb=${pb}`, async () => {
        const { db } = fakeDb({
          [CASHBACK_CONFIG_KEY]: cfg({ enabled, bots, bundles, bills }),
          [USSD_SERVICE_VISIBILITY_KEY]: { networkPlans: np, payBills: pb },
        })
        expect(await botMenusVisible(db)).toEqual({
          networkPlans: enabled && bots && bundles && np,
          payBills: enabled && bots && bills && pb,
        })
      })
    }
  }
})

describe("botMenusVisible: defaults and failures", () => {
  it("no cashback row => both hidden; no visibility row => flags default on (the cashback switch is the gate)", async () => {
    expect(await botMenusVisible(fakeDb({}).db)).toEqual({ networkPlans: false, payBills: false })
    expect(await botMenusVisible(fakeDb({ [CASHBACK_CONFIG_KEY]: cfg() }).db)).toEqual({ networkPlans: true, payBills: true })
  })

  it("a cashback config read error hides both (fail closed), never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = fakeDb({ [CASHBACK_CONFIG_KEY]: new Error("db down") })
    expect(await botMenusVisible(db)).toEqual({ networkPlans: false, payBills: false })
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it("a visibility read error hides both (fail closed), never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = fakeDb({ [CASHBACK_CONFIG_KEY]: cfg(), [USSD_SERVICE_VISIBILITY_KEY]: new Error("db down") })
    expect(await botMenusVisible(db)).toEqual({ networkPlans: false, payBills: false })
    err.mockRestore()
  })

  it("a visibility map passed in is used as is (no second read); both flags off => the cashback config is not read", async () => {
    const { db, reads } = fakeDb({ [CASHBACK_CONFIG_KEY]: cfg() })
    const vis = { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: false }
    expect(await botMenusVisible(db, vis)).toEqual({ networkPlans: true, payBills: false })
    expect(reads).toEqual([CASHBACK_CONFIG_KEY])
    const off = fakeDb({ [CASHBACK_CONFIG_KEY]: cfg() })
    expect(await botMenusVisible(off.db, { ...vis, networkPlans: false })).toEqual({ networkPlans: false, payBills: false })
    expect(off.reads).toEqual([])
  })

  it("a malformed config never opens a menu", () => {
    const vis = { networkPlans: true, payBills: true }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { enabled: "yes", surfaces: { bots: 1 }, botGroups: { bundles: "true", bills: 1 } } as any
    expect(uzoBotMenus(bad, vis)).toEqual({ networkPlans: false, payBills: false })
  })
})
