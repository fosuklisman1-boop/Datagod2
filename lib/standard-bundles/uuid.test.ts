import { describe, it, expect } from "vitest"
import { newUuid } from "./uuid"
import { isValidIdempotencyKey } from "./service"

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("newUuid", () => {
  it("uses crypto.randomUUID when present", () => {
    expect(newUuid({ randomUUID: () => "0f8fad5b-d9cb-469f-a165-70867728950e" })).toBe("0f8fad5b-d9cb-469f-a165-70867728950e")
  })
  it("falls back to getRandomValues and produces a v4 UUID", () => {
    let calls = 0
    const id = newUuid({ getRandomValues: <T extends Uint8Array>(a: T) => { calls++; a.fill(0xff); return a } })
    expect(calls).toBe(1)
    expect(id).toMatch(V4)
    expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff")
  })
  it("falls back when randomUUID throws (non-secure context)", () => {
    const id = newUuid({ randomUUID: () => { throw new Error("insecure") }, getRandomValues: <T extends Uint8Array>(a: T) => a })
    expect(id).toBe("00000000-0000-4000-8000-000000000000")
  })
  it("last resort without crypto still returns a valid v4 UUID that the server accepts", () => {
    const id = newUuid({})
    expect(id).toMatch(V4)
    expect(isValidIdempotencyKey(id)).toBe(true)
    expect(newUuid(undefined)).toMatch(V4)
  })
  it("default (real crypto) works and is unique", () => {
    const a = newUuid(), b = newUuid()
    expect(a).toMatch(V4)
    expect(a).not.toBe(b)
  })
})
