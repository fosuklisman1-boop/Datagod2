import { describe, it, expect } from "vitest"
import { HUBTEL_CS_SERVICES, HUBTEL_CS_SERVICE_KEYS, getService, isServiceKey } from "./services"

describe("hubtel-cs service registry", () => {
  it("every service id is a 32-char hex id and ids are unique", () => {
    const ids = HUBTEL_CS_SERVICE_KEYS.map(k => HUBTEL_CS_SERVICES[k].serviceId)
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("maps the documented ServiceIDs", () => {
    expect(getService("airtime_mtn").serviceId).toBe("fdd76c884e614b1c8f669a3207b09a98")
    expect(getService("airtime_telecel").serviceId).toBe("f4be83ad74c742e185224fdae1304800")
    expect(getService("airtime_at").serviceId).toBe("dae2142eb5a14c298eace60240c09e4b")
    expect(getService("data_mtn").serviceId).toBe("b230733cd56b4a0fad820e39f66bc27c")
    expect(getService("data_telecel").serviceId).toBe("fa27127ba039455da04a2ac8a1613e00")
    expect(getService("data_at").serviceId).toBe("06abd92da459428496967612463575ca")
    expect(getService("bill_ecg").serviceId).toBe("e6d6bac062b5499cb1ece1ac3d742a84")
    expect(getService("bill_ghana_water").serviceId).toBe("6c1e8a82d2e84feeb8bfd6be2790d71d")
    expect(getService("bill_dstv").serviceId).toBe("297a96656b5846ad8b00d5d41b256ea7")
    expect(getService("bill_gotv").serviceId).toBe("e6ceac7f3880435cb30b048e9617eb41")
    expect(getService("bill_startimes").serviceId).toBe("6598652d34ea4112949c93c079c501ce")
    expect(getService("bill_telecel_broadband").serviceId).toBe("b9a1aa246ba748f9ba01ca4cdbb3d1d3")
  })

  it("airtime is capped at GHS 100, has no query and needs no bundle", () => {
    for (const k of ["airtime_mtn", "airtime_telecel", "airtime_at"] as const) {
      const s = getService(k)
      expect(s.maxAmount).toBe(100)
      expect(s.hasQuery).toBe(false)
      expect(s.needsBundle).toBe(false)
      expect(s.kind).toBe("airtime")
    }
  })

  it("data, ecg, ghana water and broadband need a bundle; tv does not", () => {
    for (const k of ["data_mtn", "data_telecel", "data_at", "bill_ecg", "bill_ghana_water", "bill_telecel_broadband"] as const) {
      expect(getService(k).needsBundle).toBe(true)
    }
    for (const k of ["bill_dstv", "bill_gotv", "bill_startimes"] as const) {
      expect(getService(k).needsBundle).toBe(false)
      expect(getService(k).hasQuery).toBe(true)
    }
  })

  it("broadband is registered but disabled by default", () => {
    expect(getService("bill_telecel_broadband").defaultEnabled).toBe(false)
    expect(getService("airtime_mtn").defaultEnabled).toBe(true)
  })

  it("isServiceKey rejects unknown and inherited keys", () => {
    expect(isServiceKey("airtime_mtn")).toBe(true)
    expect(isServiceKey("constructor")).toBe(false)
    expect(isServiceKey("toString")).toBe(false)
    expect(isServiceKey(42)).toBe(false)
  })

  it("getService throws on an unknown key", () => {
    expect(() => getService("nope" as any)).toThrow(/unknown hubtel service/i)
  })
})
