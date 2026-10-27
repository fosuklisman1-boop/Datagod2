import { describe, it, expect } from "vitest"
import {
  SMS_MAX_RECIPIENTS,
  normalizeSmsRecipient,
  parseSmsSendBody,
  smsHash,
  classifySmsError,
  smsErrorResponse,
  mapSendSummary,
  mapCampaign,
  mapCampaignDetail,
  mapSenders,
  mapBalance,
} from "./sms-rules"

const NOW = new Date("2026-10-27T10:00:00Z")
const P1 = "0249991060"
const P2 = "0249991061"
const P3 = "0249991062"
const BODY = { reference: "SMS-1060", message: "Hello there", recipients: [P1, P2] }

function ok(body: unknown, now = NOW) {
  const r = parseSmsSendBody(body, now)
  if (!r.ok) throw new Error("expected ok: " + r.error)
  return r.value
}
function bad(body: unknown, now = NOW) {
  const r = parseSmsSendBody(body, now)
  if (r.ok) throw new Error("expected failure")
  return r.error
}
function many(n: number): string[] {
  // distinct valid-looking local numbers: 0244 + 6 digits
  return Array.from({ length: n }, (_, i) => "0244" + String(100000 + i))
}

describe("normalizeSmsRecipient", () => {
  it("normalises every accepted spelling to +233XXXXXXXXX", () => {
    for (const s of [P1, "233249991060", "+233249991060", "249991060", " 024 999-1060 ", "(0249991060)"]) {
      expect(normalizeSmsRecipient(s)).toBe("+233249991060")
    }
  })
  it("returns null for anything the engine would skip", () => {
    for (const s of ["", "abc", "12345", "02499910601", "+23324999106", "+1249991060"]) {
      expect(normalizeSmsRecipient(s)).toBeNull()
    }
  })
})

describe("parseSmsSendBody", () => {
  it("accepts the minimal body", () => {
    const v = ok(BODY)
    expect(v.reference).toBe("SMS-1060")
    expect(v.message).toBe("Hello there")
    expect(v.recipients).toEqual([P1, P2])
    expect(v.senderId).toBeNull()
    expect(v.scheduledFor).toBeNull()
  })

  it("rejects non-object bodies", () => {
    for (const b of [null, undefined, "x", 5, [], [BODY]]) expect(bad(b)).toMatch(/JSON object/)
  })

  it("requires a valid reference", () => {
    expect(bad({ ...BODY, reference: undefined })).toMatch(/reference/)
    expect(bad({ ...BODY, reference: "ab" })).toMatch(/reference/)
    expect(bad({ ...BODY, reference: "has space" })).toMatch(/reference/)
    expect(bad({ ...BODY, reference: 12345 })).toMatch(/reference/)
  })

  it("message length bounds are 3..1000", () => {
    expect(bad({ ...BODY, message: "ab" })).toMatch(/message/)
    expect(ok({ ...BODY, message: "abc" }).message).toBe("abc")
    expect(ok({ ...BODY, message: "a".repeat(1000) }).message).toHaveLength(1000)
    expect(bad({ ...BODY, message: "a".repeat(1001) })).toMatch(/message/)
    expect(bad({ ...BODY, message: undefined })).toMatch(/message/)
    expect(bad({ ...BODY, message: 12345 })).toMatch(/message/)
    expect(bad({ ...BODY, message: ["abc"] })).toMatch(/message/)
  })

  it("keeps the message exactly as sent (no trimming)", () => {
    expect(ok({ ...BODY, message: "  hi  " }).message).toBe("  hi  ")
  })

  it("recipients: must be a non-empty array of strings", () => {
    expect(bad({ ...BODY, recipients: undefined })).toMatch(/recipients/)
    expect(bad({ ...BODY, recipients: [] })).toMatch(/recipients/)
    expect(bad({ ...BODY, recipients: P1 })).toMatch(/recipients/)
    expect(bad({ ...BODY, recipients: [P1, 249991061] })).toMatch(/recipients/)
    expect(bad({ ...BODY, recipients: [P1, null] })).toMatch(/recipients/)
    expect(bad({ ...BODY, recipients: [P1, { a: 1 }] })).toMatch(/recipients/)
  })

  it("recipients: 1 ok, exactly 5000 ok, 5001 rejected", () => {
    expect(ok({ ...BODY, recipients: [P1] }).recipients).toEqual([P1])
    expect(SMS_MAX_RECIPIENTS).toBe(5000)
    expect(ok({ ...BODY, recipients: many(5000) }).recipients).toHaveLength(5000)
    expect(bad({ ...BODY, recipients: many(5001) })).toMatch(/5000/)
  })

  it("recipients: a hugely oversized raw array is rejected without scanning it", () => {
    expect(bad({ ...BODY, recipients: Array.from({ length: 50001 }, () => P1) })).toMatch(/recipients/)
  })

  it("recipients: duplicates collapse, first original spelling is kept, order preserved", () => {
    const v = ok({ ...BODY, recipients: [P2, P1, P2, "+233249991060", "233249991061"] })
    expect(v.recipients).toEqual([P2, P1])
    expect(v.recipientCount).toBe(2)
  })

  it("recipients: 5001 raw entries that dedupe to 5000 are accepted", () => {
    const list = many(5000)
    expect(ok({ ...BODY, recipients: [...list, list[0]] }).recipients).toHaveLength(5000)
  })

  it("recipients: mixed forms normalise to one sorted list for hashing", () => {
    const v = ok({ ...BODY, recipients: ["+233249991061", P1, "249991062"] })
    expect(v.normalizedRecipients).toEqual(["+233249991060", "+233249991061", "+233249991062"])
    expect(v.recipients).toEqual(["+233249991061", P1, "249991062"])
  })

  it("recipients: invalid-but-string entries are passed to the engine (it counts invalid_skipped)", () => {
    const v = ok({ ...BODY, recipients: [P1, "not-a-number", "not-a-number"] })
    expect(v.recipients).toEqual([P1, "not-a-number"])
  })

  it("recipients: only invalid strings still parse (engine answers NO_VALID_RECIPIENTS)", () => {
    expect(ok({ ...BODY, recipients: ["nope"] }).recipients).toEqual(["nope"])
  })

  it("sender_id: optional, non-blank string, trimmed", () => {
    expect(ok({ ...BODY, sender_id: " KINGS " }).senderId).toBe("KINGS")
    expect(ok({ ...BODY, sender_id: null }).senderId).toBeNull()
    expect(bad({ ...BODY, sender_id: "" })).toMatch(/sender_id/)
    expect(bad({ ...BODY, sender_id: "   " })).toMatch(/sender_id/)
    expect(bad({ ...BODY, sender_id: 5 })).toMatch(/sender_id/)
    expect(bad({ ...BODY, sender_id: ["A"] })).toMatch(/sender_id/)
  })

  it("scheduled_at: bounds 2 minutes to 30 days, explicit offset required", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
    expect(ok({ ...BODY, scheduled_at: null }).scheduledFor).toBeNull()
    expect(ok({ ...BODY, scheduled_at: at(2 * 60_000) }).scheduledFor?.toISOString()).toBe(at(2 * 60_000))
    expect(bad({ ...BODY, scheduled_at: at(2 * 60_000 - 1000) })).toMatch(/2 minutes/)
    expect(ok({ ...BODY, scheduled_at: at(30 * 24 * 3_600_000) }).scheduledFor).toBeInstanceOf(Date)
    expect(bad({ ...BODY, scheduled_at: at(30 * 24 * 3_600_000 + 1000) })).toMatch(/30 days/)
    expect(bad({ ...BODY, scheduled_at: "2026-10-28T10:00:00" })).toMatch(/timezone/)
    expect(bad({ ...BODY, scheduled_at: "tomorrow" })).toMatch(/timezone/)
    expect(bad({ ...BODY, scheduled_at: 1790000000 })).toMatch(/timezone/)
  })

  it("rejects forbidden fields case-insensitively", () => {
    for (const f of ["provider", "price", "cost", "credits", "status", "user_id", "account_id", "fee", "amount", "Provider", "CREDITS"]) {
      expect(bad({ ...BODY, [f]: "x" })).toBe("Unexpected field")
    }
  })

  it("ignores unrelated unknown fields", () => {
    expect(ok({ ...BODY, note: "x" }).reference).toBe("SMS-1060")
  })
})

describe("smsHash", () => {
  it("is a sha256 hex string", () => {
    expect(smsHash(ok(BODY))).toMatch(/^[0-9a-f]{64}$/)
  })
  it("is equal across spellings, order and duplicates of the same recipients", () => {
    const a = smsHash(ok({ ...BODY, recipients: [P1, P2] }))
    const b = smsHash(ok({ ...BODY, recipients: ["+233249991061", "249991060", P1] }))
    expect(a).toBe(b)
  })
  it("ignores the reference", () => {
    expect(smsHash(ok(BODY))).toBe(smsHash(ok({ ...BODY, reference: "SMS-OTHER" })))
  })
  it("changes with the message, recipients, sender and schedule", () => {
    const base = smsHash(ok(BODY))
    expect(smsHash(ok({ ...BODY, message: "Hello there!" }))).not.toBe(base)
    expect(smsHash(ok({ ...BODY, recipients: [P1, P3] }))).not.toBe(base)
    expect(smsHash(ok({ ...BODY, sender_id: "KINGS" }))).not.toBe(base)
    expect(smsHash(ok({ ...BODY, scheduled_at: "2026-10-27T11:00:00Z" }))).not.toBe(base)
  })
  it("treats equivalent schedule spellings as the same instant", () => {
    const a = smsHash(ok({ ...BODY, scheduled_at: "2026-10-27T11:00:00Z" }))
    const b = smsHash(ok({ ...BODY, scheduled_at: "2026-10-27T12:00:00+01:00" }))
    expect(a).toBe(b)
  })
  it("never contains the message or a phone number in anything but the digest", () => {
    expect(smsHash(ok(BODY))).not.toContain("Hello")
  })
})

describe("classifySmsError", () => {
  const NO_CHARGE = [
    "BLOCKED", "NOT_ACTIVATED", "SUSPENDED", "INSUFFICIENT_CREDITS", "INVALID_SENDER_ID", "SMS_DISABLED",
    "POLICY_REJECTED", "SEND_IN_PROGRESS", "EMPTY_MESSAGE", "TOO_MANY_RECIPIENTS", "NO_VALID_RECIPIENTS",
  ]
  it.each(NO_CHARGE)("returned %s is no_charge", (error) => {
    expect(classifySmsError({ ok: false, error })).toBe("no_charge")
  })
  it("ENQUEUE_FAILED is ambiguous: the engine's compensating refund is best-effort, so a retry could double-charge", () => {
    expect(classifySmsError({ ok: false, error: "ENQUEUE_FAILED" })).toBe("ambiguous")
  })
  it("a thrown Error is ambiguous", () => {
    expect(classifySmsError(new Error("boom"))).toBe("ambiguous")
    expect(classifySmsError(new TypeError("x"))).toBe("ambiguous")
  })
  it("an unrecognised or malformed result is ambiguous", () => {
    expect(classifySmsError({ ok: false, error: "SOMETHING_NEW" })).toBe("ambiguous")
    expect(classifySmsError({ ok: false })).toBe("ambiguous")
    expect(classifySmsError({ error: "INSUFFICIENT_CREDITS" })).toBe("ambiguous") // no ok:false => not an engine return
    expect(classifySmsError({ ok: true, error: "BLOCKED" })).toBe("ambiguous")
    expect(classifySmsError(null)).toBe("ambiguous")
    expect(classifySmsError(undefined)).toBe("ambiguous")
    expect(classifySmsError("INSUFFICIENT_CREDITS")).toBe("ambiguous")
    expect(classifySmsError({ ok: false, error: ["BLOCKED"] })).toBe("ambiguous")
  })
  it("prototype-pollution style names are ambiguous", () => {
    expect(classifySmsError({ ok: false, error: "constructor" })).toBe("ambiguous")
    expect(classifySmsError({ ok: false, error: "__proto__" })).toBe("ambiguous")
  })
})

describe("smsErrorResponse", () => {
  const r = (error: string, extra: object = {}) => smsErrorResponse({ ok: false, error, ...extra })
  it("maps the fixed statuses and codes", () => {
    expect(r("INSUFFICIENT_CREDITS")).toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" })
    expect(r("NOT_ACTIVATED")).toMatchObject({ status: 403, code: "NOT_ACTIVATED" })
    expect(r("SUSPENDED")).toMatchObject({ status: 403, code: "SUSPENDED" })
    expect(r("INVALID_SENDER_ID")).toMatchObject({ status: 400, code: "INVALID_SENDER_ID" })
    expect(r("SMS_DISABLED")).toMatchObject({ status: 503, code: "SMS_DISABLED" })
    expect(r("EMPTY_MESSAGE")).toMatchObject({ status: 400, code: "EMPTY_MESSAGE" })
    expect(r("TOO_MANY_RECIPIENTS")).toMatchObject({ status: 400, code: "TOO_MANY_RECIPIENTS" })
    expect(r("NO_VALID_RECIPIENTS")).toMatchObject({ status: 400, code: "NO_VALID_RECIPIENTS" })
    expect(r("ENQUEUE_FAILED")).toMatchObject({ status: 500, code: "OUTCOME_UNKNOWN" })
  })
  it("BLOCKED shows only the customer-safe reason of a policy block, else a fixed text", () => {
    expect(r("BLOCKED", { code: "SOME_POLICY", reason: "Remove the link and try again." })).toMatchObject({
      status: 400,
      code: "BLOCKED",
      message: "Remove the link and try again.",
    })
    // No policy code => the reason may be raw filter text: never forwarded.
    const raw = r("BLOCKED", { reason: "matched keyword: lottery" })
    expect(raw.message).not.toContain("lottery")
    expect(raw.message).toBe("This message contains content we can't send.")
    expect(r("BLOCKED", { code: "SOME_POLICY", reason: "   " }).message).toBe("This message contains content we can't send.")
  })
  it("POLICY_REJECTED: 400 with the reason, 503 when the policy is unavailable or disabled", () => {
    expect(r("POLICY_REJECTED", { code: "DAILY_CAP", reason: "Daily limit reached." })).toMatchObject({
      status: 400,
      code: "POLICY_REJECTED",
      message: "Daily limit reached.",
    })
    expect(r("POLICY_REJECTED", { code: "POLICY_UNAVAILABLE", reason: "Try later." }).status).toBe(503)
    expect(r("POLICY_REJECTED", { code: "FEATURE_DISABLED", reason: "Off." }).status).toBe(503)
    const noReason = r("POLICY_REJECTED", { code: "DAILY_CAP" })
    expect(noReason.message.length).toBeGreaterThan(0)
  })
  it("caps a very long reason", () => {
    expect(r("POLICY_REJECTED", { code: "X", reason: "a".repeat(2000) }).message.length).toBeLessThanOrEqual(300)
  })
  it("SEND_IN_PROGRESS is 429 and never invites a new reference", () => {
    const e = r("SEND_IN_PROGRESS", { reason: "ignored engine text" })
    expect(e.status).toBe(429)
    expect(e.code).toBe("SEND_IN_PROGRESS")
    expect(e.message).toMatch(/same reference/i)
    expect(e.message).not.toMatch(/use a new reference|different reference|another reference/i)
    expect(e.message).not.toContain("ignored engine text")
  })
  it("thrown and unknown errors are OUTCOME_UNKNOWN with a do-not-resend tail, never the engine text", () => {
    for (const e of [new Error("secret db detail"), { ok: false, error: "NEW_THING" }, null, undefined, "x"]) {
      const out = smsErrorResponse(e)
      expect(out.status).toBe(500)
      expect(out.code).toBe("OUTCOME_UNKNOWN")
      expect(out.message).toMatch(/Do not send this again under a new reference/)
      expect(out.message).not.toContain("secret")
    }
  })
})

describe("mapSendSummary", () => {
  const result = {
    ok: true as const,
    batches: 2,
    totalQueued: 700,
    segments: 1,
    creditsReserved: 700,
    invalidSkipped: 3,
    partial: false,
    held: false,
    scheduled: false,
    scheduledFor: null,
    sendLogId: "9001",
  }
  it("maps to exactly the allow-listed keys", () => {
    const s = mapSendSummary({ ...result, internal: "x", message: "leak", recipients: [P1] } as any)
    expect(Object.keys(s).sort()).toEqual(
      ["batches", "campaign_id", "credits_reserved", "held", "invalid_skipped", "partial", "scheduled", "scheduled_for", "segments", "status", "stopped_reason", "total"].sort()
    )
    expect(s).toMatchObject({
      campaign_id: "9001",
      status: "queued",
      total: 700,
      batches: 2,
      segments: 1,
      credits_reserved: 700,
      invalid_skipped: 3,
      partial: false,
      stopped_reason: null,
      held: false,
      scheduled: false,
      scheduled_for: null,
    })
  })
  it("status: held beats scheduled beats queued", () => {
    expect(mapSendSummary({ ...result, held: true, scheduled: true }).status).toBe("held")
    expect(mapSendSummary({ ...result, scheduled: true, scheduledFor: "2026-10-28T10:00:00.000Z" })).toMatchObject({
      status: "scheduled",
      scheduled_for: "2026-10-28T10:00:00.000Z",
    })
  })
  it("partial passes the stop reason only when it is a known code", () => {
    expect(mapSendSummary({ ...result, partial: true, stoppedReason: "INSUFFICIENT_CREDITS" })).toMatchObject({
      partial: true,
      stopped_reason: "INSUFFICIENT_CREDITS",
    })
    expect(mapSendSummary({ ...result, partial: true, stoppedReason: "SEND_ERROR" }).stopped_reason).toBe("SEND_ERROR")
    expect(mapSendSummary({ ...result, partial: true, stoppedReason: "db password=hunter2" }).stopped_reason).toBe("SEND_ERROR")
    expect(mapSendSummary({ ...result, partial: true }).stopped_reason).toBe("SEND_ERROR")
    expect(mapSendSummary({ ...result, partial: false, stoppedReason: "BLOCKED" }).stopped_reason).toBeNull()
  })
  it("a missing send log id reads null; ids are strings", () => {
    expect(mapSendSummary({ ...result, sendLogId: null }).campaign_id).toBeNull()
    expect(mapSendSummary({ ...result, sendLogId: 77 as any }).campaign_id).toBe("77")
  })
  it("coerces junk numbers to 0", () => {
    const s = mapSendSummary({ ...result, totalQueued: NaN, creditsReserved: "x" as any })
    expect(s.total).toBe(0)
    expect(s.credits_reserved).toBe(0)
  })
})

describe("mapCampaign", () => {
  const row = {
    id: 9001,
    status: "sent",
    message: "SECRET BODY",
    sender_id: "KINGS",
    recipients_count: 700,
    segments: 1,
    credits_reserved: 700,
    credits_used: 690,
    created_at: "2026-10-27T10:00:00Z",
    completed_at: "2026-10-27T10:05:00Z",
    scheduled_for: null,
    source: "campaign",
    policy_shadow: { x: 1 },
    sms_account_id: "acc-1",
  }
  it("exposes exactly the allow-list and never the message body", () => {
    const c = mapCampaign(row)
    expect(Object.keys(c).sort()).toEqual(
      ["campaign_id", "completed_at", "created_at", "credits_reserved", "credits_used", "recipient_count", "scheduled_for", "segments", "sender_id", "status"].sort()
    )
    expect(c).toMatchObject({ campaign_id: "9001", status: "sent", sender_id: "KINGS", recipient_count: 700, credits_used: 690 })
    expect(JSON.stringify(c)).not.toContain("SECRET")
    expect(JSON.stringify(c)).not.toContain("acc-1")
  })
  it("known statuses pass; failed+cancelled reads cancelled; unknown reads unknown", () => {
    for (const s of ["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"]) {
      expect(mapCampaign({ ...row, status: s }).status).toBe(s)
    }
    expect(mapCampaign({ ...row, status: "failed", cancelled: true }).status).toBe("cancelled")
    expect(mapCampaign({ ...row, status: "failed", cancelled: false }).status).toBe("failed")
    expect(mapCampaign({ ...row, status: "weird" }).status).toBe("unknown")
    expect(mapCampaign({ ...row, status: undefined }).status).toBe("unknown")
  })
  it("tolerates a null row and legacy rows without scheduled_for", () => {
    const { scheduled_for: _s, source: _o, ...legacy } = row
    expect(mapCampaign(legacy).scheduled_for).toBeNull()
    expect(mapCampaign(null).campaign_id).toBe("")
  })
})

describe("mapCampaignDetail", () => {
  const record = {
    log: { id: 9001, status: "sent", message: "SECRET BODY", sender_id: "KINGS", recipients_count: 3, segments: 1, credits_reserved: 3, credits_used: 3, created_at: "2026-10-27T10:00:00Z", completed_at: null },
    messages: [
      { id: "m1", phone: "+233249991060", status: "sent", attempts: 1, last_error: "provider 500 key=abc", processed_at: "x", delivery_status: "delivered", refunded: false },
      { id: "m2", phone: "+233249991061", status: "failed", attempts: 3, last_error: "boom", processed_at: null, delivery_status: null, refunded: true },
      { id: "m3", phone: "0249991062", status: "pending", attempts: 0, last_error: null, processed_at: null, delivery_status: null, refunded: false },
    ],
    counts: { delivered: 1, failed: 1, pending: 1, refunded: 1 },
  }
  it("maps campaign fields, delivery counts and recipients with E.164 phones and statuses", () => {
    const d = mapCampaignDetail(record)
    expect(d.campaign_id).toBe("9001")
    expect(d.delivery).toEqual({ delivered: 1, failed: 1, pending: 1, refunded: 1 })
    expect(d.recipients).toEqual([
      { phone: "+233249991060", status: "delivered", refunded: false },
      { phone: "+233249991061", status: "failed", refunded: true },
      { phone: "+233249991062", status: "pending", refunded: false },
    ])
  })
  it("never leaks provider internals, ids, errors or the body", () => {
    const s = JSON.stringify(mapCampaignDetail(record))
    for (const leak of ["SECRET", "provider 500", "key=abc", "attempts", "last_error", "m1", "processed_at"]) {
      expect(s).not.toContain(leak)
    }
  })
  it("status precedence: delivered > failed > sent > pending", () => {
    const m = (o: object) =>
      mapCampaignDetail({ ...record, messages: [{ phone: P1, status: "pending", delivery_status: null, refunded: false, ...o }] }).recipients[0].status
    expect(m({ delivery_status: "delivered", status: "failed" })).toBe("delivered")
    expect(m({ delivery_status: "failed" })).toBe("failed")
    expect(m({ status: "failed" })).toBe("failed")
    expect(m({ status: "sent" })).toBe("sent")
    expect(m({})).toBe("pending")
    expect(m({ status: "claimed" })).toBe("pending")
  })
  it("tolerates missing messages/counts", () => {
    const d = mapCampaignDetail({ log: record.log } as any)
    expect(d.recipients).toEqual([])
    expect(d.delivery).toEqual({ delivered: 0, failed: 0, pending: 0, refunded: 0 })
  })
})

describe("mapSenders", () => {
  const rows = [
    { id: "s1", sender_id: "KINGS", local_status: "active", created_at: "2026-10-01T00:00:00Z", sms_account_id: "acc-1", rejection_reason: "x", kyc_free: true },
    { id: "s2", sender_id: "OTHER", local_status: "pending", created_at: "2026-10-02T00:00:00Z" },
    { id: "s3", sender_id: "ODD", local_status: "mystery" },
  ]
  it("allow-lists fields and flags the default by row id", () => {
    const out = mapSenders(rows, "s1")
    expect(out).toEqual([
      { sender_id: "KINGS", status: "active", is_default: true, created_at: "2026-10-01T00:00:00Z" },
      { sender_id: "OTHER", status: "pending", is_default: false, created_at: "2026-10-02T00:00:00Z" },
      { sender_id: "ODD", status: "unavailable", is_default: false, created_at: null },
    ])
    expect(JSON.stringify(out)).not.toContain("acc-1")
    expect(JSON.stringify(out)).not.toContain("rejection")
  })
  it("a paused/rejected/revoked sender is never the default", () => {
    const out = mapSenders([{ id: "s1", sender_id: "A", local_status: "paused" }], "s1")
    expect(out[0].is_default).toBe(false)
    expect(out[0].status).toBe("paused")
  })
  it("no default id, empty or non-array input", () => {
    expect(mapSenders(rows, null).every((s) => s.is_default === false)).toBe(true)
    expect(mapSenders([], "s1")).toEqual([])
    expect(mapSenders(null as any, "s1")).toEqual([])
  })
})

describe("mapBalance", () => {
  it("returns credits, pending credits and the account status only", () => {
    const b = mapBalance({ id: "a", user_id: "u", unit_balance: 120, status: "active", mode: "business", api_rate_limit_override: 5 } as any, 30)
    expect(b).toEqual({ credits: 120, pending_credits: 30, status: "active" })
  })
  it("coerces junk and unknown statuses safely", () => {
    expect(mapBalance({ unit_balance: "x", status: "weird" } as any, NaN)).toEqual({ credits: 0, pending_credits: 0, status: "unknown" })
    expect(mapBalance({ unit_balance: -5, status: "suspended" } as any, -1)).toEqual({ credits: 0, pending_credits: 0, status: "suspended" })
    expect(mapBalance({ unit_balance: 4.9, status: "inactive" } as any, 2)).toMatchObject({ credits: 4, status: "inactive" })
  })
})
