import { describe, it, expect } from "vitest"
import {
  NEW_NAV_ITEMS,
  NAV_NEW_MAX_CLICKS,
  isRegisteredNavHref,
  isNavNew,
  recordNavClick,
  sanitizeNavClicks,
  parseNavClicksPayload,
  type NavClicks,
} from "./nav-new"

describe("NEW_NAV_ITEMS registry", () => {
  it("tags the customer SMS and admin SMS Platform items", () => {
    expect(NEW_NAV_ITEMS["/dashboard/sms"]).toBeDefined()
    expect(NEW_NAV_ITEMS["/admin/sms"]).toBeDefined()
  })

  it("every entry has an ISO since date and a href the DB CHECK accepts", () => {
    for (const [href, entry] of Object.entries(NEW_NAV_ITEMS)) {
      expect(entry.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(href.startsWith("/")).toBe(true)
      expect(href.length).toBeGreaterThan(0)
      expect(href.length).toBeLessThanOrEqual(200)
    }
  })

  it("max clicks is 2 (the second click clears the tag)", () => {
    expect(NAV_NEW_MAX_CLICKS).toBe(2)
  })
})

describe("isRegisteredNavHref", () => {
  it("accepts registry hrefs only", () => {
    expect(isRegisteredNavHref("/dashboard/sms")).toBe(true)
    expect(isRegisteredNavHref("/admin/sms")).toBe(true)
    expect(isRegisteredNavHref("/dashboard/wallet")).toBe(false)
    expect(isRegisteredNavHref("constructor")).toBe(false)
    expect(isRegisteredNavHref("__proto__")).toBe(false)
    expect(isRegisteredNavHref(undefined)).toBe(false)
    expect(isRegisteredNavHref(42)).toBe(false)
  })
})

describe("isNavNew", () => {
  it("is new at 0 clicks", () => {
    expect(isNavNew("/dashboard/sms", {})).toBe(true)
  })
  it("is still new after the first click", () => {
    expect(isNavNew("/dashboard/sms", { "/dashboard/sms": 1 })).toBe(true)
  })
  it("is no longer new after the second click", () => {
    expect(isNavNew("/dashboard/sms", { "/dashboard/sms": 2 })).toBe(false)
  })
  it("never tags hrefs outside the registry", () => {
    expect(isNavNew("/dashboard/wallet", {})).toBe(false)
    expect(isNavNew("/admin/sms-centre", {})).toBe(false)
  })
  it("shows nothing while clicks are not loaded (null) -- fail quiet", () => {
    expect(isNavNew("/dashboard/sms", null)).toBe(false)
  })
  it("treats junk counts as 0", () => {
    expect(isNavNew("/admin/sms", { "/admin/sms": NaN as unknown as number })).toBe(true)
  })
})

describe("recordNavClick", () => {
  it("increments a registry href", () => {
    expect(recordNavClick({}, "/admin/sms")).toEqual({ "/admin/sms": 1 })
    expect(recordNavClick({ "/admin/sms": 1 }, "/admin/sms")).toEqual({ "/admin/sms": 2 })
  })
  it("caps at 2", () => {
    expect(recordNavClick({ "/admin/sms": 2 }, "/admin/sms")).toEqual({ "/admin/sms": 2 })
  })
  it("ignores hrefs outside the registry", () => {
    const clicks: NavClicks = { "/admin/sms": 1 }
    expect(recordNavClick(clicks, "/dashboard/wallet")).toEqual({ "/admin/sms": 1 })
  })
  it("does not mutate its input", () => {
    const clicks: NavClicks = Object.freeze({ "/dashboard/sms": 1 })
    const next = recordNavClick(clicks, "/dashboard/sms")
    expect(clicks).toEqual({ "/dashboard/sms": 1 })
    expect(next).not.toBe(clicks)
    expect(next).toEqual({ "/dashboard/sms": 2 })
  })
  it("two clicks clear the tag", () => {
    let clicks: NavClicks = {}
    clicks = recordNavClick(clicks, "/dashboard/sms")
    expect(isNavNew("/dashboard/sms", clicks)).toBe(true)
    clicks = recordNavClick(clicks, "/dashboard/sms")
    expect(isNavNew("/dashboard/sms", clicks)).toBe(false)
  })
})

describe("sanitizeNavClicks", () => {
  it("keeps only registry hrefs, clamps to 0..2, drops non-numbers", () => {
    expect(sanitizeNavClicks({ "/dashboard/sms": 9, "/admin/sms": -1, "/other": 1 })).toEqual({ "/dashboard/sms": 2, "/admin/sms": 0 })
    expect(sanitizeNavClicks({ "/dashboard/sms": "1" })).toEqual({})
    expect(sanitizeNavClicks({ "/dashboard/sms": 1.7 })).toEqual({ "/dashboard/sms": 1 })
  })
  it("returns {} for non-objects", () => {
    expect(sanitizeNavClicks(null)).toEqual({})
    expect(sanitizeNavClicks([1, 2])).toEqual({})
    expect(sanitizeNavClicks("x")).toEqual({})
  })
})

describe("parseNavClicksPayload (GET /api/user/nav-new body)", () => {
  it("reads data.clicks from a success payload", () => {
    expect(parseNavClicksPayload({ success: true, data: { clicks: { "/dashboard/sms": 1 } } })).toEqual({ "/dashboard/sms": 1 })
  })
  it("returns null (no tags) for anything that is not a success payload", () => {
    expect(parseNavClicksPayload(null)).toBeNull()
    expect(parseNavClicksPayload({ success: false, error: "x" })).toBeNull()
    expect(parseNavClicksPayload({ success: true })).toBeNull()
    expect(parseNavClicksPayload({ success: true, data: { clicks: [] } })).toBeNull()
    expect(parseNavClicksPayload("garbage")).toBeNull()
  })
})
