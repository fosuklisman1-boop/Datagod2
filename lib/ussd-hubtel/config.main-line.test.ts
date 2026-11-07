import { describe, it, expect } from "vitest"
import {
  getHubtelMainLineConfig, getHubtelUssdConfig, setHubtelMainLineConfig, setHubtelUssdConfig,
  HUBTEL_USSD_CONFIG_KEY, HUBTEL_USSD_MAIN_LINE_CONFIG_KEY,
} from "./config"

/** admin_settings keyed by `key`, so a write to the wrong row shows up. */
function fakeSettings(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed))
  const upserted: string[] = []
  const client: any = {
    from: () => ({
      select: () => ({
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => ({ data: rows.has(key) ? { value: rows.get(key) } : null, error: null }),
        }),
      }),
      upsert: async (row: any) => { upserted.push(row.key); rows.set(row.key, row.value); return { error: null } },
    }),
  }
  return { client, rows, upserted }
}

const ALL_VISIBLE = { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true }
const SHOP_ROW = { enabled: true, mode: "shop", welcome: "Welcome customer", brandName: "Clingshub", visibility: { afa: false, data: true, airtime: true, resultsChecker: true } }

describe("getHubtelMainLineConfig", () => {
  it("is off with all six services and the default brand when no row exists", async () => {
    const { client } = fakeSettings({ [HUBTEL_USSD_CONFIG_KEY]: SHOP_ROW })
    expect(await getHubtelMainLineConfig(client)).toEqual({
      enabled: false, mode: "main", visibility: ALL_VISIBLE,
      brandName: "Clingshub", welcome: "Welcome to Clingshub", welcomeCustom: false,
    })
  })
  it("stays off for anything but an explicit true, including malformed rows", async () => {
    for (const value of [{ enabled: "true" }, { enabled: 1 }, "on", []]) {
      const { client } = fakeSettings({ [HUBTEL_USSD_MAIN_LINE_CONFIG_KEY]: value })
      expect((await getHubtelMainLineConfig(client)).enabled).toBe(false)
    }
  })
  it("always resolves to main mode, even if a row stores shop", async () => {
    const { client } = fakeSettings({ [HUBTEL_USSD_MAIN_LINE_CONFIG_KEY]: { enabled: true, mode: "shop" } })
    expect(await getHubtelMainLineConfig(client)).toMatchObject({ enabled: true, mode: "main" })
  })
  it("falls back to the defaults for an invalid stored brand or welcome", async () => {
    const { client } = fakeSettings({ [HUBTEL_USSD_MAIN_LINE_CONFIG_KEY]: { brandName: "bad\nbrand", welcome: "x".repeat(61) } })
    expect(await getHubtelMainLineConfig(client)).toMatchObject({ brandName: "Clingshub", welcome: "Welcome to Clingshub", welcomeCustom: false })
  })
})

describe("the two lines stay isolated", () => {
  const MAIN_ROW = { enabled: false, brandName: "Other", visibility: { ...ALL_VISIBLE, afa: true } }

  it("saving the main line writes only its own key", async () => {
    const { client, rows, upserted } = fakeSettings({ [HUBTEL_USSD_CONFIG_KEY]: SHOP_ROW, [HUBTEL_USSD_MAIN_LINE_CONFIG_KEY]: MAIN_ROW })
    const before = structuredClone(rows.get(HUBTEL_USSD_CONFIG_KEY))
    await setHubtelMainLineConfig(client, { enabled: true })
    expect(upserted).toEqual([HUBTEL_USSD_MAIN_LINE_CONFIG_KEY])
    expect(rows.get(HUBTEL_USSD_CONFIG_KEY)).toEqual(before)
  })
  it("saving the existing line writes only its own key", async () => {
    const { client, rows, upserted } = fakeSettings({ [HUBTEL_USSD_CONFIG_KEY]: SHOP_ROW, [HUBTEL_USSD_MAIN_LINE_CONFIG_KEY]: MAIN_ROW })
    const before = structuredClone(rows.get(HUBTEL_USSD_MAIN_LINE_CONFIG_KEY))
    await setHubtelUssdConfig(client, { enabled: false })
    expect(upserted).toEqual([HUBTEL_USSD_CONFIG_KEY])
    expect(rows.get(HUBTEL_USSD_MAIN_LINE_CONFIG_KEY)).toEqual(before)
  })
  it("reading the existing line still returns its stored shop settings", async () => {
    const { client } = fakeSettings({ [HUBTEL_USSD_CONFIG_KEY]: SHOP_ROW, [HUBTEL_USSD_MAIN_LINE_CONFIG_KEY]: { enabled: false } })
    expect(await getHubtelUssdConfig(client)).toMatchObject({ enabled: true, mode: "shop", welcome: "Welcome customer" })
  })
})

describe("setHubtelMainLineConfig", () => {
  it("stores no mode field", async () => {
    const { client, rows } = fakeSettings()
    await setHubtelMainLineConfig(client, { enabled: true })
    expect(rows.get(HUBTEL_USSD_MAIN_LINE_CONFIG_KEY)).not.toHaveProperty("mode")
  })
  it("keeps the other fields on a partial patch", async () => {
    const { client } = fakeSettings()
    await setHubtelMainLineConfig(client, { enabled: true, brandName: "Brand One", welcome: "Hello there" })
    const after = await setHubtelMainLineConfig(client, { visibility: { afa: false } })
    expect(after).toMatchObject({ enabled: true, brandName: "Brand One", welcome: "Hello there", welcomeCustom: true })
    expect(after.visibility).toEqual({ ...ALL_VISIBLE, afa: false })
  })
  it("clears a custom welcome with null", async () => {
    const { client } = fakeSettings()
    await setHubtelMainLineConfig(client, { welcome: "Hello there" })
    expect(await setHubtelMainLineConfig(client, { welcome: null })).toMatchObject({ welcome: "Welcome to Clingshub", welcomeCustom: false })
  })
  it("throws on an invalid brand before writing anything", async () => {
    const { client, upserted } = fakeSettings()
    await expect(setHubtelMainLineConfig(client, { brandName: "bad\nbrand" })).rejects.toThrow(/invalid brandName/)
    expect(upserted).toEqual([])
  })
})
