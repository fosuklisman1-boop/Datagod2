import { describe, it, expect, beforeEach, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/lib/ai-provider-config"
import { loadAIConfig, loadAIConfigChecked, resetAIConfigCache } from "./load-config"

function client(result: () => Promise<unknown>) {
  const calls = { n: 0 }
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: () => {
      calls.n++
      return result()
    },
  }
  return { c: { from: () => b }, calls }
}

beforeEach(() => resetAIConfigCache())

describe("loadAIConfigChecked", () => {
  it("returns the stored config, not failed, and caches it", async () => {
    const { c, calls } = client(async () => ({ data: { value: { admin_catalog_enabled: true } }, error: null }))
    const a = await loadAIConfigChecked(c)
    expect(a).toEqual({ config: { admin_catalog_enabled: true }, failed: false })
    await loadAIConfigChecked(c)
    expect(calls.n).toBe(1)
  })

  it("a returned DB error is failed with defaults and is NOT cached", async () => {
    const { c, calls } = client(async () => ({ data: null, error: { message: "boom" } }))
    const a = await loadAIConfigChecked(c)
    expect(a.failed).toBe(true)
    expect(a.config).toBe(DEFAULT_CONFIG)
    await loadAIConfigChecked(c)
    expect(calls.n).toBe(2)
  })

  it("a thrown error is failed and not cached", async () => {
    const { c, calls } = client(async () => {
      throw new Error("net")
    })
    expect((await loadAIConfigChecked(c)).failed).toBe(true)
    await loadAIConfigChecked(c)
    expect(calls.n).toBe(2)
  })

  it("a recovered read replaces the failure on the next call", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "x" } })
      .mockResolvedValueOnce({ data: { value: { admin_catalog_enabled: true } }, error: null })
    const { c } = client(fn)
    expect((await loadAIConfigChecked(c)).failed).toBe(true)
    expect(await loadAIConfigChecked(c)).toEqual({ config: { admin_catalog_enabled: true }, failed: false })
  })

  it("loadAIConfig still returns defaults on error (non-admin callers unchanged)", async () => {
    const { c } = client(async () => ({ data: null, error: { message: "x" } }))
    expect(await loadAIConfig(c)).toBe(DEFAULT_CONFIG)
  })
})
