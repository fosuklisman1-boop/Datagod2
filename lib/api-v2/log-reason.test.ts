import { describe, it, expect } from "vitest"
import { logReason, LOG_REASON_CODES } from "./log-reason"
import {
  MSG_PENDING,
  MSG_REVOKED,
  MSG_SUSPENDED,
  MSG_ROLE_NOT_ALLOWED,
  MSG_UNAVAILABLE,
  MSG_UNAUTHORIZED,
  msgWrongKeyType,
} from "./access"
import * as bundlesLib from "./bundles"
import * as afa from "./endpoints/afa"
import * as airtime from "./endpoints/airtime"
import * as bills from "./endpoints/bills"
import * as bundles from "./endpoints/bundles"
import * as data from "./endpoints/data"
import * as results from "./endpoints/results"
import * as sms from "./endpoints/sms"

describe("logReason", () => {
  it("is null for success statuses", () => {
    expect(logReason(200)).toBeNull()
    expect(logReason(201, "anything")).toBeNull()
    expect(logReason(299)).toBeNull()
  })

  it("maps access messages by exact constant", () => {
    expect(logReason(403, MSG_PENDING)).toBe("key_pending")
    expect(logReason(403, MSG_REVOKED)).toBe("key_revoked")
    expect(logReason(403, MSG_SUSPENDED)).toBe("account_suspended")
    expect(logReason(403, MSG_ROLE_NOT_ALLOWED)).toBe("not_eligible")
    expect(logReason(503, MSG_UNAVAILABLE)).toBe("unavailable")
  })

  it("maps the wrong-key-type message for every key type, exactly", () => {
    for (const t of ["standard", "commission", "sms"]) {
      expect(logReason(403, msgWrongKeyType(t))).toBe("wrong_key_type")
    }
    expect(logReason(403, "This endpoint requires a 0241234567 key")).toBe("http_403")
    expect(logReason(403, msgWrongKeyType("standard") + " x")).toBe("http_403")
  })

  it("maps a code from the closed list to its lowercase slug", () => {
    expect(logReason(409, "OUTCOME_UNKNOWN: for 0241234567")).toBe("outcome_unknown")
    expect(logReason(409, "REQUEST_IN_PROGRESS: a request is processing")).toBe("request_in_progress")
    expect(logReason(409, "REFERENCE_REUSED: reference already used")).toBe("reference_reused")
  })

  it("never turns an unlisted or free-text message into a slug", () => {
    expect(logReason(400, "SOME_0241234567: x")).toBe("http_400")
    expect(logReason(400, "bad phone 0241234567")).toBe("http_400")
    expect(logReason(400, "FOO_BAR: user@example.com")).toBe("http_400")
    expect(logReason(402, "outcome_unknown: lowercase")).toBe("http_402")
    expect(logReason(500, "Internal server error")).toBe("http_500")
    expect(logReason(401, MSG_UNAUTHORIZED)).toBe("http_401")
    expect(logReason(404)).toBe("http_404")
  })

  it("only ever yields a short slug", () => {
    for (const code of LOG_REASON_CODES) {
      expect(logReason(400, `${code}: x`)).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it("covers every code-prefixed MSG_* constant exported by the endpoint modules", () => {
    const modules = { bundlesLib, afa, airtime, bills, bundles, data, results, sms }
    const prefix = /^([A-Z][A-Z0-9_]+): /
    let checked = 0
    for (const [name, mod] of Object.entries(modules)) {
      for (const [key, value] of Object.entries(mod as Record<string, unknown>)) {
        if (!key.startsWith("MSG_") || typeof value !== "string") continue
        const m = prefix.exec(value)
        if (!m) continue
        checked++
        expect(LOG_REASON_CODES.has(m[1]), `${name}.${key} uses code ${m[1]}`).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(30)
  })
})
