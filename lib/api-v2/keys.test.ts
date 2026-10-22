import { describe, it, expect } from "vitest"
import { generateV2Key, parseV2Key, hashV2Key, type KeyType, type Environment } from "./keys"

describe("generateV2Key", () => {
  it("uses the right prefix per type and env", () => {
    expect(generateV2Key("standard", "live").key.startsWith("dg2_live_")).toBe(true)
    expect(generateV2Key("commission", "live").key.startsWith("dg2_cs_live_")).toBe(true)
    expect(generateV2Key("sms", "test").key.startsWith("dg2_sms_test_")).toBe(true)
  })

  it("round-trips through parseV2Key for all six combinations", () => {
    const types: KeyType[] = ["standard", "commission", "sms"]
    const envs: Environment[] = ["test", "live"]
    for (const t of types) {
      for (const e of envs) {
        expect(parseV2Key(generateV2Key(t, e).key)).toEqual({ type: t, env: e })
      }
    }
  })

  it("hash matches hashV2Key, keys are unique, prefix is first 16 chars", () => {
    const a = generateV2Key("standard", "live")
    const b = generateV2Key("standard", "live")
    expect(a.hash).toBe(hashV2Key(a.key))
    expect(a.key).not.toBe(b.key)
    expect(a.prefix).toBe(a.key.slice(0, 16))
  })
})

describe("parseV2Key", () => {
  it("rejects v1 keys, empty, bodyless and malformed input", () => {
    expect(parseV2Key("dg_live_abc")).toBeNull()
    expect(parseV2Key("")).toBeNull()
    expect(parseV2Key("dg2_live_")).toBeNull()
    expect(parseV2Key("dg2_cs_live_x y")).toBeNull()
  })
  it("rejects uppercase hex and a trailing newline", () => {
    const { key } = generateV2Key("standard", "live")
    expect(parseV2Key(key)).not.toBeNull()
    expect(parseV2Key("dg2_live_ABCDEF0123")).toBeNull()
    expect(parseV2Key(key.toUpperCase())).toBeNull()
    expect(parseV2Key(key + "\n")).toBeNull()
  })
})
