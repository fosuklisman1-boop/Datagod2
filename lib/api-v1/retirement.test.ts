import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearV1RetirementCache,
  formatGhanaDate,
  getV1RetirementConfig,
  noticeText,
  retiredBody,
  retirementHeaders,
  v1RetirementState,
} from "./retirement"

const SUNSET = new Date("2026-11-26T00:00:00Z")
const before = new Date("2026-11-20T00:00:00Z")
const after = new Date("2026-11-27T00:00:00Z")
const cfg = { sunsetAt: SUNSET, exemptUserIds: ["vip"] }

describe("v1RetirementState", () => {
  it("is normal when config is unreadable (null)", () => {
    expect(v1RetirementState(null, "u1", after)).toEqual({ mode: "normal", sunsetAt: null })
  })
  it("is normal when no sunset is set", () => {
    expect(v1RetirementState({ sunsetAt: null, exemptUserIds: [] }, "u1", after).mode).toBe("normal")
  })
  it("notice before the sunset for non-exempt users", () => {
    expect(v1RetirementState(cfg, "u1", before)).toEqual({ mode: "notice", sunsetAt: SUNSET })
  })
  it("exempt before and after the sunset", () => {
    expect(v1RetirementState(cfg, "vip", before).mode).toBe("exempt")
    expect(v1RetirementState(cfg, "vip", after).mode).toBe("exempt")
  })
  it("blocked at exactly the sunset and after", () => {
    expect(v1RetirementState(cfg, "u1", SUNSET).mode).toBe("blocked")
    expect(v1RetirementState(cfg, "u1", after).mode).toBe("blocked")
  })
})

describe("formatting", () => {
  it("formats Ghana date in GMT", () => {
    expect(formatGhanaDate(SUNSET)).toBe("26 Nov 2026, 00:00 GMT")
  })
  it("retiredBody has the exact message", () => {
    expect(retiredBody(SUNSET)).toEqual({
      success: false,
      error: "api_v1_retired",
      message:
        "API v1 was retired on 26 Nov 2026, 00:00 GMT. Please move to API v2: https://www.datagod.store/developers",
    })
  })
  it("retirementHeaders gives exactly three headers", () => {
    expect(retirementHeaders(SUNSET)).toEqual({
      Deprecation: "true",
      Sunset: SUNSET.toUTCString(),
      Link: '<https://www.datagod.store/developers>; rel="successor-version"',
    })
  })
  it("noticeText mentions the date", () => {
    expect(noticeText(SUNSET)).toContain("will be retired on 26 Nov 2026, 00:00 GMT")
  })
})

function fakeClient(result: () => unknown) {
  const maybeSingle = vi.fn(async () => result())
  const client = { from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })) }
  return { client, maybeSingle }
}

describe("getV1RetirementConfig", () => {
  beforeEach(() => {
    clearV1RetirementCache()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("returns null when the client throws", async () => {
    const { client } = fakeClient(() => {
      throw new Error("down")
    })
    expect(await getV1RetirementConfig(() => client)).toBeNull()
  })

  it("returns null on a query error", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "x" } }))
    expect(await getV1RetirementConfig(() => client)).toBeNull()
  })

  it("maps the row and caches for 60s", async () => {
    const { client, maybeSingle } = fakeClient(() => ({
      data: { v1_sunset_at: "2026-11-26T00:00:00Z", v1_exempt_user_ids: ["a"] },
      error: null,
    }))
    const a = await getV1RetirementConfig(() => client)
    const b = await getV1RetirementConfig(() => client)
    expect(a).toEqual({ sunsetAt: SUNSET, exemptUserIds: ["a"] })
    expect(b).toEqual(a)
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  it("re-reads after clearV1RetirementCache", async () => {
    const { client, maybeSingle } = fakeClient(() => ({
      data: { v1_sunset_at: null, v1_exempt_user_ids: null },
      error: null,
    }))
    expect(await getV1RetirementConfig(() => client)).toEqual({ sunsetAt: null, exemptUserIds: [] })
    clearV1RetirementCache()
    await getV1RetirementConfig(() => client)
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })
})
