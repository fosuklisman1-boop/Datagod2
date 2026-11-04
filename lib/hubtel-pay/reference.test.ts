import { describe, it, expect } from "vitest"
import { newHubtelReference } from "./reference"

const FORBIDDEN = /wallet|data|bundle|airtime|sms|upgrade|shop|afa|bill|result|topup|dealer/i

describe("newHubtelReference", () => {
  const refs = Array.from({ length: 1000 }, () => newHubtelReference())

  it("returns 1,000 unique references", () => {
    expect(new Set(refs).size).toBe(1000)
  })

  it("is always 32 lowercase hex characters", () => {
    for (const r of refs) expect(r).toMatch(/^[0-9a-f]{32}$/)
  })

  it("never contains a surface or product word", () => {
    for (const r of refs) expect(r).not.toMatch(FORBIDDEN)
  })
})
