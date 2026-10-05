import { describe, it, expect } from "vitest"
import { getHubtelUssdConfig, setHubtelUssdConfig, hubtelEnvReady } from "./config"

describe("hubtelEnvReady", () => {
  const all = { HUBTEL_WEBHOOK_SECRET: "a", HUBTEL_RELAY_URL: "b", HUBTEL_RELAY_SECRET: "c" }
  it("is ready when all set", () => {
    expect(hubtelEnvReady(all)).toEqual({ ready: true, missing: [] })
  })
  for (const k of Object.keys(all)) {
    it(`reports ${k} missing`, () => {
      const env: Record<string, string | undefined> = { ...all }
      delete env[k]
      expect(hubtelEnvReady(env)).toEqual({ ready: false, missing: [k] })
    })
  }
  it("treats empty string as missing", () => {
    expect(hubtelEnvReady({ ...all, HUBTEL_RELAY_URL: "" })).toEqual({ ready: false, missing: ["HUBTEL_RELAY_URL"] })
  })
})

function fakeSupabase(initial: unknown) {
  let stored = initial
  const client: any = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored === undefined ? null : { value: stored }, error: null }) }) }),
      upsert: async (row: any) => { stored = row.value; return { error: null } },
    }),
  }
  return { client, read: () => stored }
}

describe("hubtel ussd config", () => {
  it("defaults to disabled/main/all visible when unseeded", async () => {
    const { client } = fakeSupabase(undefined)
    expect(await getHubtelUssdConfig(client)).toEqual({
      enabled: false, mode: "main",
      visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
    })
  })

  it("fills missing fields from defaults and ignores a bad mode", async () => {
    const { client } = fakeSupabase({ enabled: true, mode: "bogus", visibility: { afa: false } })
    const cfg = await getHubtelUssdConfig(client)
    expect(cfg.enabled).toBe(true)
    expect(cfg.mode).toBe("main")
    expect(cfg.visibility).toEqual({ data: true, afa: false, airtime: true, resultsChecker: true })
  })

  it("set merges a partial patch and persists", async () => {
    const { client, read } = fakeSupabase({ enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } })
    const cfg = await setHubtelUssdConfig(client, { enabled: true, visibility: { airtime: false } })
    expect(cfg).toEqual({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: false, resultsChecker: true } })
    expect(read()).toEqual(cfg)
  })

  it("rejects an invalid mode", async () => {
    const { client } = fakeSupabase(undefined)
    await expect(setHubtelUssdConfig(client, { mode: "weird" as any })).rejects.toThrow("invalid mode")
  })
})
