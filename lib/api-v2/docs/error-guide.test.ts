import { describe, expect, it } from "vitest"
import { v2DocsRegistry, type V2DocSection } from "./registry"
import { buildErrorGuide, filterErrorGuide } from "./error-guide"
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
    for (const entry of guide) for (const m of entry.messages) {
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
      expect(e.endpoints.length, e.anchor).toBeGreaterThan(0)
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
