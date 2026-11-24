import { describe, expect, it } from "vitest"
import { v2DocsRegistry, type V2DocSection } from "./registry"
import { buildErrorGuide, filterErrorGuide } from "./error-guide"
import { MSG_PAUSED, MSG_SERVICE_PAUSED_DEFAULT } from "../access"

describe("pause errors (Release 4)", () => {
  it("lists the 403 developer pause and the 503 service pause once each, API-wide", () => {
    const guide = buildErrorGuide()
    const paused = guide.filter((e) => e.messages.includes(MSG_PAUSED))
    expect(paused).toHaveLength(1)
    expect(paused[0]).toMatchObject({ status: 403, group: "Access and keys", endpoints: [] })
    expect(paused[0].appliesTo).toMatch(/every endpoint/i)
    expect(paused[0].fix).toMatch(/nothing is revoked|keys still/i)
    const service = guide.filter((e) => e.messages.includes(MSG_SERVICE_PAUSED_DEFAULT))
    expect(service).toHaveLength(1)
    expect(service[0]).toMatchObject({ status: 503, group: "Availability" })
    expect(service[0].appliesTo).toMatch(/purchase/i)
    expect(service[0].fix).toMatch(/same reference/i)
    expect(service[0].fix).toContain("/developers/status")
    expect(new Set(guide.map((e) => e.anchor)).size).toBe(guide.length)
  })
})
import { errorAnchor } from "./error-key"
import {
  MSG_UNAUTHORIZED,
  MSG_UNAVAILABLE,
  MSG_SUSPENDED,
  MSG_PENDING,
  MSG_REVOKED,
  MSG_ROLE_NOT_ALLOWED,
  MSG_RATE_LIMITED,
  msgWrongKeyType,
} from "../access"

const guide = buildErrorGuide(v2DocsRegistry)

function registryPairs(): Set<string> {
  const pairs = new Set<string>()
  for (const s of v2DocsRegistry) for (const e of s.endpoints) for (const r of e.errors) pairs.add(`${r.status}|${r.message}`)
  return pairs
}

describe("buildErrorGuide", () => {
  it("puts every distinct (status, message) pair of the registry in exactly one entry", () => {
    const pairs = registryPairs()
    expect(pairs.size).toBe(145)
    const seen = new Map<string, number>()
    // API-wide entries (admin pauses, appliesTo set) are not in any endpoint's error list by design.
    for (const entry of guide.filter((e) => !e.appliesTo)) for (const m of entry.messages) {
      const k = `${entry.status}|${m}`
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    expect(new Set(seen.keys())).toEqual(pairs)
    for (const n of seen.values()) expect(n).toBe(1)
  })

  it("gives every entry a meaning, a different fix and at least one endpoint", () => {
    for (const e of guide) {
      expect(e.meaning.trim().length, e.anchor).toBeGreaterThan(0)
      expect(e.fix.trim().length, e.anchor).toBeGreaterThan(0)
      expect(e.fix, e.anchor).not.toBe(e.meaning)
      if (e.appliesTo) expect(e.appliesTo.trim().length, e.anchor).toBeGreaterThan(0)
      else expect(e.endpoints.length, e.anchor).toBeGreaterThan(0)
      for (const ep of e.endpoints) expect(ep.href).toContain(`#endpoint-${ep.id}`)
    }
  })

  it("merges the wallet and test-balance INSUFFICIENT_BALANCE messages under one anchor", () => {
    const entries = guide.filter((e) => e.code === "INSUFFICIENT_BALANCE")
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe(402)
    expect(entries[0].messages.some((m) => m.includes("wallet balance is too low"))).toBe(true)
    expect(entries[0].messages.some((m) => m.includes("test balance is too low"))).toBe(true)
  })

  it("keeps anchors unique and splits one code across statuses", () => {
    const anchors = guide.map((e) => e.anchor)
    expect(new Set(anchors).size).toBe(anchors.length)
    const unknown = guide.filter((e) => e.code === "OUTCOME_UNKNOWN")
    expect(unknown.map((e) => e.status).sort()).toEqual([409, 500])
    for (const e of guide) expect(e.anchor).toBe(errorAnchor(e.status, e.messages[0]))
  })

  it("fails loudly for an error with no advice", () => {
    const synthetic: V2DocSection[] = [
      {
        id: "x",
        label: "X",
        group: "data",
        endpoints: [
          {
            id: "x-1",
            group: "data",
            method: "POST",
            path: "/x",
            keyType: null,
            rateLimit: "",
            summary: "",
            params: [],
            requestExample: null,
            successExample: {},
            errors: [{ status: 400, message: "WEIRD_NEW: x" }],
            notes: [],
          },
        ],
      },
    ]
    expect(() => buildErrorGuide(synthetic)).toThrow(/WEIRD_NEW/)
  })

  it("files every standard access message under Access and keys", () => {
    const messages = [
      [401, MSG_UNAUTHORIZED],
      [503, MSG_UNAVAILABLE],
      [403, MSG_SUSPENDED],
      [403, MSG_PENDING],
      [403, MSG_REVOKED],
      [403, MSG_ROLE_NOT_ALLOWED],
      [429, MSG_RATE_LIMITED],
      [403, msgWrongKeyType("standard")],
      [403, msgWrongKeyType("commission")],
      [403, msgWrongKeyType("sms")],
    ] as const
    for (const [status, message] of messages) {
      const entry = guide.find((e) => e.status === status && e.messages.includes(message))
      expect(entry, message).toBeDefined()
      expect(entry!.group).toBe("Access and keys")
    }
  })

  it("is sorted by group order, then status, then code", () => {
    const order = ["Access and keys", "Validation", "Money", "References and idempotency", "Orders and lookups", "Availability", "Providers and upstream"]
    for (let i = 1; i < guide.length; i++) {
      const a = guide[i - 1]
      const b = guide[i]
      const ga = order.indexOf(a.group)
      const gb = order.indexOf(b.group)
      expect(ga).toBeLessThanOrEqual(gb)
      if (ga === gb) {
        expect(a.status).toBeLessThanOrEqual(b.status)
        if (a.status === b.status) expect((a.code ?? "") <= (b.code ?? "") || a.code === null || b.code === null).toBe(true)
      }
    }
  })
})

describe("filterErrorGuide", () => {
  it("matches a status number", () => {
    const r = filterErrorGuide(guide, "409")
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((e) => e.status === 409)).toBe(true)
  })
  it("finds REFERENCE_REUSED by the word reference", () => {
    expect(filterErrorGuide(guide, "reference").some((e) => e.code === "REFERENCE_REUSED")).toBe(true)
  })
  it("returns everything for blank input", () => {
    expect(filterErrorGuide(guide, "   ")).toHaveLength(guide.length)
    expect(filterErrorGuide(guide, "")).toHaveLength(guide.length)
  })
  it("returns nothing for an unmatched query", () => {
    expect(filterErrorGuide(guide, "zzzz-no-such-thing")).toEqual([])
  })
})

describe("SMS unknown-outcome advice", () => {
  const guide = buildErrorGuide(v2DocsRegistry)
  const smsEntries = guide.filter(
    (e) =>
      (e.code === "OUTCOME_UNKNOWN" || e.code === "REQUEST_IN_PROGRESS") &&
      e.endpoints.some((ep) => ep.path.startsWith("/sms/")),
  )
  it("covers 409 REQUEST_IN_PROGRESS, 409 OUTCOME_UNKNOWN and 500 OUTCOME_UNKNOWN", () => {
    expect(smsEntries.map((e) => `${e.status}-${e.code}`).sort()).toEqual([
      "409-OUTCOME_UNKNOWN",
      "409-REQUEST_IN_PROGRESS",
      "500-OUTCOME_UNKNOWN",
    ])
  })
  it("tells SMS senders to check campaigns and balance, not to poll an order, and never to resend with a new reference", () => {
    for (const e of smsEntries) {
      expect(e.fix, e.anchor).toContain("GET /sms/campaigns")
      expect(e.fix, e.anchor).toContain("GET /sms/balance")
      expect(e.fix, e.anchor).toMatch(/no lookup by reference/i)
      expect(e.fix, e.anchor).toMatch(/new reference/i)
      expect(e.fix, e.anchor).toMatch(/contact support/i)
    }
  })
})
