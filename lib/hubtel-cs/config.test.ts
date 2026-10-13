import { describe, it, expect } from "vitest"
import { buildConfigPatch, hubtelCsEnvReady, resolveConfig, setHubtelCsConfig, setHubtelCsPaused, validateConfigPatch } from "./config"

function fakeRpcDb(returnValue: unknown = {}) {
  const calls: { fn: string; args: any }[] = []
  return {
    calls,
    db: { rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: returnValue, error: null } } } as any,
  }
}

describe("atomic config patch (phase 2a)", () => {
  it("never emits pause keys for a plain admin save", () => {
    const p = buildConfigPatch({ enabled: true, mode: "relay" })
    expect(p).toEqual({ enabled: true, mode: "relay" })
    expect("paused" in p).toBe(false)
  })
  it("emits all three pause keys only on an explicit resume", () => {
    expect(buildConfigPatch({ paused: false })).toEqual({ paused: false, pausedReason: null, pausedAt: null })
  })
  it("passes services and a null threshold through", () => {
    expect(buildConfigPatch({ services: { airtime_mtn: false }, lowBalanceThreshold: null }))
      .toEqual({ services: { airtime_mtn: false }, lowBalanceThreshold: null })
  })
  it("setHubtelCsConfig calls the patch RPC and resolves its result", async () => {
    const f = fakeRpcDb({ enabled: true, mode: "direct", services: {} })
    const cfg = await setHubtelCsConfig(f.db, { enabled: true })
    expect(f.calls).toEqual([{ fn: "hubtel_cs_config_patch", args: { p_patch: { enabled: true } } }])
    expect(cfg.enabled).toBe(true)
  })
  it("setHubtelCsPaused writes only pause keys", async () => {
    const f = fakeRpcDb({ paused: true, pausedReason: "4075" })
    await setHubtelCsPaused(f.db, "4075")
    const p = f.calls[0].args.p_patch
    expect(Object.keys(p).sort()).toEqual(["paused", "pausedAt", "pausedReason"])
    expect(p.paused).toBe(true)
    expect(p.pausedReason).toBe("4075")
  })
  it("setHubtelCsPaused(null) resumes", async () => {
    const f = fakeRpcDb({})
    await setHubtelCsPaused(f.db, null)
    expect(f.calls[0].args.p_patch).toEqual({ paused: false, pausedReason: null, pausedAt: null })
  })
  it("throws the RPC error", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "boom" } }) } as any
    await expect(setHubtelCsPaused(db, "x")).rejects.toMatchObject({ message: "boom" })
  })
})

describe("resolveConfig", () => {
  it("defaults dark: disabled, direct, unpaused, per-service defaults", () => {
    const c = resolveConfig(undefined)
    expect(c.enabled).toBe(false)
    expect(c.mode).toBe("direct")
    expect(c.paused).toBe(false)
    expect(c.lowBalanceThreshold).toBeNull()
    expect(c.services.airtime_mtn).toBe(true)
    expect(c.services.bill_telecel_broadband).toBe(false)
  })
  it("only an explicit true enables; only 'relay' selects relay", () => {
    expect(resolveConfig({ enabled: "true" }).enabled).toBe(false)
    expect(resolveConfig({ enabled: true }).enabled).toBe(true)
    expect(resolveConfig({ mode: "relay" }).mode).toBe("relay")
    expect(resolveConfig({ mode: "weird" }).mode).toBe("direct")
  })
  it("ignores unknown service keys and non-boolean values; keeps valid overrides", () => {
    const c = resolveConfig({ services: { airtime_mtn: false, bill_ecg: "yes", nope: true } })
    expect(c.services.airtime_mtn).toBe(false)
    expect(c.services.bill_ecg).toBe(true)
    expect((c.services as any).nope).toBeUndefined()
  })
  it("a bad or non-positive threshold resolves to null", () => {
    expect(resolveConfig({ lowBalanceThreshold: 250 }).lowBalanceThreshold).toBe(250)
    expect(resolveConfig({ lowBalanceThreshold: 0 }).lowBalanceThreshold).toBeNull()
    expect(resolveConfig({ lowBalanceThreshold: "x" }).lowBalanceThreshold).toBeNull()
  })
  it("carries the pause state", () => {
    const c = resolveConfig({ paused: true, pausedReason: "4075", pausedAt: "2026-10-13T10:00:00.000Z" })
    expect(c.paused).toBe(true)
    expect(c.pausedReason).toBe("4075")
  })
})

describe("validateConfigPatch", () => {
  it("accepts valid patches", () => {
    expect(validateConfigPatch({ enabled: true, mode: "relay", lowBalanceThreshold: 100, services: { airtime_mtn: false }, paused: false }))
      .toEqual({ ok: true, patch: { enabled: true, mode: "relay", lowBalanceThreshold: 100, services: { airtime_mtn: false }, paused: false } })
    expect(validateConfigPatch({ lowBalanceThreshold: null })).toEqual({ ok: true, patch: { lowBalanceThreshold: null } })
  })
  it("rejects bad types, unknown keys and unknown services", () => {
    expect(validateConfigPatch(null).ok).toBe(false)
    expect(validateConfigPatch({ enabled: "yes" }).ok).toBe(false)
    expect(validateConfigPatch({ mode: "tunnel" }).ok).toBe(false)
    expect(validateConfigPatch({ lowBalanceThreshold: -5 }).ok).toBe(false)
    expect(validateConfigPatch({ lowBalanceThreshold: Infinity }).ok).toBe(false)
    expect(validateConfigPatch({ services: { nope: true } }).ok).toBe(false)
    expect(validateConfigPatch({ services: { airtime_mtn: "on" } }).ok).toBe(false)
    expect(validateConfigPatch({ surprise: 1 }).ok).toBe(false)
  })
  it("an admin can only clear the pause, never set it", () => {
    expect(validateConfigPatch({ paused: true }).ok).toBe(false)
    expect(validateConfigPatch({ paused: false }).ok).toBe(true)
  })
})

describe("hubtelCsEnvReady", () => {
  const base = { HUBTEL_CS_CALLBACK_SECRET: "s".repeat(32), NEXT_PUBLIC_APP_URL: "https://x", HUBTEL_RELAY_URL: "https://r", HUBTEL_RELAY_SECRET: "rs" }
  it("direct mode also needs the CS credentials", () => {
    expect(hubtelCsEnvReady("direct", base).missing.sort()).toEqual(["HUBTEL_CS_BASIC_AUTH", "HUBTEL_DISBURSEMENT_ACCOUNT"])
    expect(hubtelCsEnvReady("direct", { ...base, HUBTEL_CS_BASIC_AUTH: "a", HUBTEL_DISBURSEMENT_ACCOUNT: "11691" }).ready).toBe(true)
  })
  it("relay mode needs only the shared env (credentials live on the droplet)", () => {
    expect(hubtelCsEnvReady("relay", base).ready).toBe(true)
  })
  it("status checks always use the relay, so relay env is required in both modes", () => {
    expect(hubtelCsEnvReady("relay", { ...base, HUBTEL_RELAY_URL: "" }).missing).toEqual(["HUBTEL_RELAY_URL"])
  })
})

describe("hubtelCsEnvReady callback secret length", () => {
  const env = { NEXT_PUBLIC_APP_URL: "https://x", HUBTEL_RELAY_URL: "https://r", HUBTEL_RELAY_SECRET: "rs" }
  it("a callback secret shorter than 32 chars is not ready, reported by name only", () => {
    const r = hubtelCsEnvReady("relay", { ...env, HUBTEL_CS_CALLBACK_SECRET: "short-secret-value" })
    expect(r.ready).toBe(false)
    expect(r.missing).toEqual(["HUBTEL_CS_CALLBACK_SECRET (min 32 chars)"])
    expect(JSON.stringify(r)).not.toContain("short-secret-value")
  })
  it("32 chars is accepted", () => {
    expect(hubtelCsEnvReady("relay", { ...env, HUBTEL_CS_CALLBACK_SECRET: "x".repeat(32) }).ready).toBe(true)
  })
})
