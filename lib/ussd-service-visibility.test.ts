import { describe, it, expect, beforeEach } from "vitest"
import {
  getUssdServiceVisibility,
  setUssdServiceVisibility,
  isUssdVisibilityService,
  USSD_SERVICE_VISIBILITY_KEY,
  USSD_VISIBILITY_SERVICES,
  type UssdServiceVisibility,
} from "./ussd-service-visibility"

interface FakeState {
  storedValue: Partial<UssdServiceVisibility> | null // null = row never seeded
  upsertCalls: Array<{ key: string; value: UssdServiceVisibility }>
}

// Plain fake object literal — no @supabase/supabase-js mocking needed since
// ussd-service-visibility takes the client as a parameter (same convention
// as lib/network-stock-service.test.ts).
function createFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: () =>
                Promise.resolve(
                  key === USSD_SERVICE_VISIBILITY_KEY && state.storedValue !== null
                    ? { data: { value: state.storedValue }, error: null }
                    : { data: null, error: null }
                ),
            }),
          }),
          upsert: (row: { key: string; value: UssdServiceVisibility }) => {
            state.upsertCalls.push(row)
            state.storedValue = row.value
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  } as any
}

let state: FakeState

beforeEach(() => {
  state = { storedValue: null, upsertCalls: [] }
})

describe("getUssdServiceVisibility", () => {
  it("row never seeded: the four legacy services visible; the three Uzo cashback opt-ins OFF", async () => {
    const visibility = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(visibility).toEqual({
      data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: false, payBills: false, cashbackAirtime: false,
    })
  })

  it("partially populated: missing legacy fields default to true, missing opt-ins to false", async () => {
    state.storedValue = { data: false }
    const visibility = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(visibility).toEqual({
      data: false, afa: true, airtime: true, resultsChecker: true, networkPlans: false, payBills: false, cashbackAirtime: false,
    })
  })

  it("today's prod row (only the legacy four) reads every Uzo cashback opt-in as off (deploy is dark)", async () => {
    state.storedValue = { data: true, afa: true, airtime: true, resultsChecker: true }
    const v = await getUssdServiceVisibility(createFakeSupabase(state))
    expect([v.networkPlans, v.payBills, v.cashbackAirtime]).toEqual([false, false, false])
  })

  it("returns a fully-populated stored value untouched (opt-ins on)", async () => {
    const all = { data: false, afa: false, airtime: true, resultsChecker: false, networkPlans: true, payBills: true, cashbackAirtime: true }
    state.storedValue = all
    expect(await getUssdServiceVisibility(createFakeSupabase(state))).toEqual(all)
  })

  it("a non-boolean stored opt-in never reads as on", async () => {
    state.storedValue = { networkPlans: "true", payBills: 1, cashbackAirtime: "yes" } as any
    const v = await getUssdServiceVisibility(createFakeSupabase(state))
    expect([v.networkPlans, v.payBills, v.cashbackAirtime]).toEqual([false, false, false])
  })
})

describe("USSD_VISIBILITY_SERVICES (admin route validator)", () => {
  it("accepts the four legacy services and the three Uzo cashback opt-ins, nothing else", () => {
    expect([...USSD_VISIBILITY_SERVICES].sort()).toEqual(
      ["afa", "airtime", "cashbackAirtime", "data", "networkPlans", "payBills", "resultsChecker"],
    )
    expect(isUssdVisibilityService("cashbackAirtime")).toBe(true)
    expect(isUssdVisibilityService("whatever")).toBe(false)
    expect(isUssdVisibilityService(undefined)).toBe(false)
  })
})

describe("setUssdServiceVisibility", () => {
  it("persists a change and a subsequent get reflects it", async () => {
    const supabase = createFakeSupabase(state)
    const result = await setUssdServiceVisibility(supabase, "afa", false)
    const expected = { data: true, afa: false, airtime: true, resultsChecker: true, networkPlans: false, payBills: false, cashbackAirtime: false }
    expect(result).toEqual(expected)

    const after = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(after).toEqual(expected)
  })

  it("setting one service does not affect the others already stored", async () => {
    state.storedValue = { data: false, afa: false, airtime: false, resultsChecker: false, networkPlans: true, payBills: true, cashbackAirtime: true }
    const supabase = createFakeSupabase(state)
    const result = await setUssdServiceVisibility(supabase, "airtime", true)
    const expected = { data: false, afa: false, airtime: true, resultsChecker: false, networkPlans: true, payBills: true, cashbackAirtime: true }
    expect(result).toEqual(expected)

    const after = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(after).toEqual(expected)
  })

  it("turning an opt-in on only flips that one", async () => {
    state.storedValue = { data: true, afa: true, airtime: true, resultsChecker: true }
    const result = await setUssdServiceVisibility(createFakeSupabase(state), "cashbackAirtime", true)
    expect([result.networkPlans, result.payBills, result.cashbackAirtime]).toEqual([false, false, true])
  })
})
