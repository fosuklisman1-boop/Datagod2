import { describe, it, expect } from "vitest"
import { validateTtbSettings, normaliseSender } from "./admin-validate"

const ok = (body: unknown) => {
  const r = validateTtbSettings(body)
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.patch
}
const bad = (body: unknown) => {
  const r = validateTtbSettings(body)
  if (r.ok) throw new Error("expected a rejection")
  return r.error
}

describe("validateTtbSettings: shape", () => {
  it("rejects a non-object body", () => {
    for (const b of [null, undefined, "x", 5, true, [], [{ mainEnabled: true }]]) expect(bad(b)).toBe("body_must_be_an_object")
  })
  it("accepts an empty patch", () => {
    expect(ok({})).toEqual({})
  })
  it("rejects unknown keys, including source and the raw ttb_ keys", () => {
    expect(bad({ source: "db" })).toBe("unknown_field")
    expect(bad({ ttb_main_enabled: true })).toBe("unknown_field")
    expect(bad({ nope: 1 })).toBe("unknown_field")
    expect(bad(JSON.parse('{"__proto__": {"x": 1}}'))).toBe("unknown_field")
  })
  it("maps each field to its admin_settings key", () => {
    expect(ok({ mainEnabled: true, staleMinutes: 15 })).toEqual({ ttb_main_enabled: true, ttb_stale_minutes: 15 })
  })
  it("never echoes the value in an error", () => {
    expect(bad({ replySenderId: "SECRET_VALUE_THAT_IS_TOO_LONG" })).toBe("invalid_replySenderId")
  })
})

describe("validateTtbSettings: booleans", () => {
  for (const f of ["mainEnabled", "aiEnabled", "unclearRepliesEnabled", "airtimeEnabled", "resultsCheckerEnabled"] as const) {
    it(`${f} must be a real boolean`, () => {
      expect(ok({ [f]: true })).toBeTruthy()
      expect(ok({ [f]: false })).toBeTruthy()
      for (const v of ["true", 1, 0, null, undefined, "yes", [], {}]) expect(bad({ [f]: v })).toBe(`invalid_${f}`)
    })
  }
})

describe("validateTtbSettings: numeric ranges", () => {
  const table: [string, number, number][] = [
    ["staleMinutes", 1, 120],
    ["promptsPerHour", 1, 20],
    ["repliesPerHour", 1, 30],
    ["aiReadsPerHour", 0, 60],
    ["globalPromptsPerMinute", 1, 500],
    ["promptWindowMinutes", 2, 30],
    ["quietAlertMinutes", 10, 1440],
    ["retentionDays", 1, 90],
    ["globalRepliesPerHour", 10, 5000],
  ]
  for (const [f, min, max] of table) {
    it(`${f} accepts ${min}..${max} and nothing outside or non-integer`, () => {
      expect(ok({ [f]: min })).toBeTruthy()
      expect(ok({ [f]: max })).toBeTruthy()
      expect(bad({ [f]: min - 1 })).toBe(`invalid_${f}`)
      expect(bad({ [f]: max + 1 })).toBe(`invalid_${f}`)
      expect(bad({ [f]: min + 0.5 })).toBe(`invalid_${f}`)
      for (const v of [String(min), null, Number.NaN, Number.POSITIVE_INFINITY, true, []]) expect(bad({ [f]: v })).toBe(`invalid_${f}`)
    })
  }
})

describe("validateTtbSettings: reply cost settings", () => {
  it("maps to their admin_settings keys", () => {
    expect(ok({ unclearRepliesEnabled: false, globalRepliesPerHour: 5000 })).toEqual({ ttb_reply_to_unclear: false, ttb_global_replies_per_hour: 5000 })
  })
  it("edges of globalRepliesPerHour: 9 and 5001 rejected, 10 and 5000 accepted", () => {
    expect(bad({ globalRepliesPerHour: 9 })).toBe("invalid_globalRepliesPerHour")
    expect(bad({ globalRepliesPerHour: 5001 })).toBe("invalid_globalRepliesPerHour")
    expect(ok({ globalRepliesPerHour: 10 })).toEqual({ ttb_global_replies_per_hour: 10 })
    expect(ok({ globalRepliesPerHour: 5000 })).toEqual({ ttb_global_replies_per_hour: 5000 })
  })
})

describe("validateTtbSettings: mainNumber", () => {
  it("accepts empty and normalises every common form to local", () => {
    expect(ok({ mainNumber: "" })).toEqual({ ttb_main_number: "" })
    expect(ok({ mainNumber: "  " })).toEqual({ ttb_main_number: "" })
    for (const v of ["0200000101", "+233200000101", "233200000101", "200000101", " 020 000 0101 ", "020-000-0101"]) {
      expect(ok({ mainNumber: v })).toEqual({ ttb_main_number: "0200000101" })
    }
  })
  it("rejects a non-Ghana, short or non-string value", () => {
    for (const v of ["12345", "0100000101", "+447700900123", "abc", "02000001011", 200000101, null]) {
      expect(bad({ mainNumber: v })).toBe("invalid_mainNumber")
    }
  })
})

describe("validateTtbSettings: replySenderId", () => {
  it("accepts empty and 1..11 letters, digits and spaces", () => {
    for (const v of ["", "A", "Datagod", "Data God 24", "ABCDEFGHIJK"]) expect(ok({ replySenderId: v })).toEqual({ ttb_reply_sender_id: v })
  })
  it("rejects 12 chars, punctuation and non-strings", () => {
    for (const v of ["ABCDEFGHIJKL", "Data-God", "Data_God", "Daté", "<b>", null, 5]) expect(bad({ replySenderId: v })).toBe("invalid_replySenderId")
  })
})

describe("validateTtbSettings: shopReplySenderId", () => {
  it("accepts empty, 11 chars, digits-only numbers and spaces", () => {
    for (const v of ["", "A", "Shop Name 1", "0200000101", "ABCDEFGHIJK"]) {
      expect(ok({ shopReplySenderId: v })).toEqual({ ttb_shop_reply_sender_id: v })
    }
  })
  it("rejects 12 chars, punctuation and non-strings", () => {
    for (const v of ["ABCDEFGHIJKL", "Data-God", "Data.God", "Daté", "<b>", null, 5, undefined]) {
      expect(bad({ shopReplySenderId: v })).toBe("invalid_shopReplySenderId")
    }
  })
})

describe("validateTtbSettings: whole patch or nothing", () => {
  it("one bad field fails the lot", () => {
    expect(bad({ staleMinutes: 15, promptsPerHour: 99 })).toBe("invalid_promptsPerHour")
  })
})

describe("normaliseSender", () => {
  it("normalises or returns null", () => {
    expect(normaliseSender("+233200000102")).toBe("0200000102")
    expect(normaliseSender("nope")).toBeNull()
    expect(normaliseSender(5)).toBeNull()
    expect(normaliseSender("0".repeat(40))).toBeNull()
  })
})
