import { describe, it, expect, beforeEach } from "vitest"
import {
  getUssdServiceVisibility,
  setUssdServiceVisibility,
  USSD_SERVICE_VISIBILITY_KEY,
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
  it("defaults all services to visible when the row has never been seeded", async () => {
    const visibility = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(visibility).toEqual({ data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true })
  })

  it("defaults missing fields to true when the stored value is only partially populated", async () => {
    state.storedValue = { data: false }
    const visibility = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(visibility).toEqual({ data: false, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true })
  })

  it("reads missing networkPlans/payBills as true and keeps the legacy four as stored", async () => {
    state.storedValue = { data: false, afa: false, airtime: false, resultsChecker: false }
    const v = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(v.networkPlans).toBe(true)
    expect(v.payBills).toBe(true)
    expect([v.data, v.afa, v.airtime, v.resultsChecker]).toEqual([false, false, false, false])
  })

  it("returns a fully-populated stored value untouched", async () => {
    state.storedValue = { data: false, afa: false, airtime: true, resultsChecker: false, networkPlans: true, payBills: true }
    const visibility = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(visibility).toEqual({ data: false, afa: false, airtime: true, resultsChecker: false, networkPlans: true, payBills: true })
  })
})

describe("setUssdServiceVisibility", () => {
  it("persists a change and a subsequent get reflects it", async () => {
    const supabase = createFakeSupabase(state)
    const result = await setUssdServiceVisibility(supabase, "afa", false)
    expect(result).toEqual({ data: true, afa: false, airtime: true, resultsChecker: true, networkPlans: true, payBills: true })

    const after = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(after).toEqual({ data: true, afa: false, airtime: true, resultsChecker: true, networkPlans: true, payBills: true })
  })

  it("setting one service does not affect the others already stored", async () => {
    state.storedValue = { data: false, afa: false, airtime: false, resultsChecker: false, networkPlans: true, payBills: true }
    const supabase = createFakeSupabase(state)
    const result = await setUssdServiceVisibility(supabase, "airtime", true)
    expect(result).toEqual({ data: false, afa: false, airtime: true, resultsChecker: false, networkPlans: true, payBills: true })

    const after = await getUssdServiceVisibility(createFakeSupabase(state))
    expect(after).toEqual({ data: false, afa: false, airtime: true, resultsChecker: false, networkPlans: true, payBills: true })
  })
})
