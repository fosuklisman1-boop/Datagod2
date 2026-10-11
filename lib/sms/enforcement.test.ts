import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

const h = vi.hoisted(() => {
  const state = {
    rpcCalls: [] as { fn: string; args: any }[],
    rpcResult: { data: [{ fraud_flag_count: 1, suspended: false, review_hold: false }], error: null } as any,
    rpcThrows: false,
    evaluate: null as null | (() => Promise<any>),
    policyEnforced: false,
  }
  const fake = {
    rpc: (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args })
      if (state.rpcThrows) throw new Error("rpc threw")
      return Promise.resolve(state.rpcResult)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("./policy-context", () => ({
  buildShadow: (r: any, enforced: boolean, now = new Date()) => ({ ...r, enforced, evaluated_at: now.toISOString() }),
  evaluatePolicy: () => h.state.evaluate!(),
}))
vi.mock("./platform-settings", async (orig) => {
  const real = await orig<typeof import("./platform-settings")>()
  return { ...real, loadSmsSettings: () => Promise.resolve({ ...real.DEFAULT_SMS_SETTINGS, policyEnforced: h.state.policyEnforced }) }
})

import {
  decideOutcome, evaluateForEnforcement, isPolicyEnforced, recordFraudFlags, policyRejectedStatus, POLICY_UNAVAILABLE_REASON,
} from "./enforcement"
import { DEFAULT_SMS_SETTINGS } from "./platform-settings"

const T = { autoSuspendFlags: 2, flagReviewThreshold: 5 }
const now = new Date("2026-10-11T10:00:00Z")
const fraud = { severity: "fraud" as const, reason: 'blocked keyword: "secretword"', matched: "secretword" }
const info = { severity: "info" as const, reason: 'flagged keyword: "promo"', matched: "promo" }
const args = { accountId: "a1", sender: { kind: "platform" as const, name: null, kycFree: false }, recipientCount: 3, message: "hi" }

beforeEach(() => {
  h.state.rpcCalls.length = 0
  h.state.rpcResult = { data: [{ fraud_flag_count: 1, suspended: false, review_hold: false }], error: null }
  h.state.rpcThrows = false
  h.state.evaluate = null
  h.state.policyEnforced = false
})
afterEach(() => vi.useRealTimers())

describe("policyRejectedStatus", () => {
  it("503 for outages, 400 for rule rejections", () => {
    expect(policyRejectedStatus("FEATURE_DISABLED")).toBe(503)
    expect(policyRejectedStatus("POLICY_UNAVAILABLE")).toBe(503)
    expect(policyRejectedStatus("CAP_PER_HOUR")).toBe(400)
    expect(policyRejectedStatus("SENDER_NOT_ALLOWED")).toBe(400)
    expect(policyRejectedStatus(undefined)).toBe(400)
  })
})

describe("isPolicyEnforced", () => {
  it("reads settings.policyEnforced (default false)", async () => {
    expect(await isPolicyEnforced()).toBe(false)
    h.state.policyEnforced = true
    expect(await isPolicyEnforced()).toBe(true)
  })
})

describe("decideOutcome", () => {
  it("allow / hold carry an enforced:true shadow", () => {
    const a = decideOutcome({ decision: "allow", code: "OK", reason: "", flags: [info] }, "business", T, now)
    expect(a).toEqual({ kind: "allow", mode: "business", shadow: { decision: "allow", code: "OK", reason: "", flags: [info], enforced: true, evaluated_at: now.toISOString() } })
    const h1 = decideOutcome({ decision: "hold", code: "REVIEW_HOLD", reason: "under review", flags: [] }, "platform", T, now)
    expect(h1).toMatchObject({ kind: "hold", shadow: { decision: "hold", enforced: true } })
  })

  it("reject and unavailable → reject with code + customer reason only", () => {
    expect(decideOutcome({ decision: "reject", code: "CAP_PER_DAY", reason: "daily limit", flags: [] }, "platform", T, now))
      .toEqual({ kind: "reject", code: "CAP_PER_DAY", reason: "daily limit" })
    expect(decideOutcome({ decision: "unavailable", code: "FEATURE_DISABLED", reason: "paused", flags: [] }, "platform", T, now))
      .toEqual({ kind: "reject", code: "FEATURE_DISABLED", reason: "paused" })
  })

  it("block keeps only fraud flags for counting, and the thresholds", () => {
    const b = decideOutcome({ decision: "block", code: "CONTENT_BLOCKED", reason: "edit it", flags: [info, fraud] }, "platform", T, now)
    expect(b).toMatchObject({ kind: "block", code: "CONTENT_BLOCKED", reason: "edit it", fraudFlags: [fraud], thresholds: T })
  })
})

describe("evaluateForEnforcement", () => {
  it("maps a clean evaluation", async () => {
    h.state.evaluate = () => Promise.resolve({ mode: "platform", result: { decision: "reject", code: "CAP_PER_SEND", reason: "split it", flags: [] }, settings: DEFAULT_SMS_SETTINGS })
    expect(await evaluateForEnforcement(args)).toEqual({ kind: "reject", code: "CAP_PER_SEND", reason: "split it" })
  })

  it("loader error → fails CLOSED with a generic reason (no internals leaked)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.evaluate = () => Promise.reject(new Error("sms_account_usage failed: secret internals"))
    const r = await evaluateForEnforcement(args)
    expect(r).toEqual({ kind: "reject", code: "POLICY_UNAVAILABLE", reason: POLICY_UNAVAILABLE_REASON })
    expect(JSON.stringify(r)).not.toContain("internals")
    spy.mockRestore()
  })

  it("no account → fails CLOSED", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.evaluate = () => Promise.resolve(null)
    expect(await evaluateForEnforcement(args)).toMatchObject({ kind: "reject", code: "POLICY_UNAVAILABLE" })
    spy.mockRestore()
  })

  it("slow evaluation → fails CLOSED at the deadline", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers()
    h.state.evaluate = () => new Promise(() => {})
    const p = evaluateForEnforcement(args, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toMatchObject({ kind: "reject", code: "POLICY_UNAVAILABLE" })
    spy.mockRestore()
  })
})

describe("recordFraudFlags", () => {
  it("calls record_sms_flags with the fraud flags and thresholds", async () => {
    await recordFraudFlags({ accountId: "a1", sendLogId: 42, flags: [info, fraud], thresholds: T })
    expect(h.state.rpcCalls).toEqual([{ fn: "record_sms_flags", args: {
      p_account_id: "a1", p_send_log_id: 42, p_flags: [fraud], p_auto_suspend: 2, p_review_threshold: 5,
    } }])
  })

  it("no fraud flags → no call", async () => {
    await recordFraudFlags({ accountId: "a1", sendLogId: 42, flags: [info], thresholds: T })
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it("never throws on an RPC error or throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.rpcResult = { data: null, error: { message: "down" } }
    await expect(recordFraudFlags({ accountId: "a1", sendLogId: null, flags: [fraud], thresholds: T })).resolves.toBeUndefined()
    h.state.rpcThrows = true
    await expect(recordFraudFlags({ accountId: "a1", sendLogId: null, flags: [fraud], thresholds: T })).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

// The SQL itself can't run here (no DB in unit tests); pin the contract the TS relies on.
describe("migration 20261013_sms_policy_enforcement.sql (static contract)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "20261013_sms_policy_enforcement.sql"), "utf8")
  const fn = sql.slice(sql.indexOf("FUNCTION record_sms_flags"), sql.indexOf("$$;", sql.indexOf("FUNCTION record_sms_flags")))
  const claim = sql.slice(sql.indexOf("FUNCTION claim_sms_messages"), sql.indexOf("$$;", sql.indexOf("FUNCTION claim_sms_messages")))

  it("record_sms_flags takes exactly the parameters the TS sends", () => {
    for (const [name, type] of [["p_account_id", "UUID"], ["p_send_log_id", "BIGINT"], ["p_flags", "JSONB"], ["p_auto_suspend", "INT"], ["p_review_threshold", "INT"]]) {
      expect(fn).toMatch(new RegExp(`${name}\\s+${type}\\b`))
    }
  })
  it("locks the account row, counts fraud flags, suspends at the threshold, sets review_hold", () => {
    expect(fn).toMatch(/FOR UPDATE/)
    expect(fn).toMatch(/fraud_flag_count\s*=\s*fraud_flag_count\s*\+\s*v_new_fraud/)
    expect(fn).toMatch(/>=\s*p_auto_suspend/)
    expect(fn).toMatch(/status\s*=\s*'suspended'/)
    expect(fn).toMatch(/>=\s*p_review_threshold/)
    expect(fn).toMatch(/review_hold\s*=\s*true/)
  })
  it("claim_sms_messages never claims messages of held/scheduled campaigns", () => {
    expect(claim).toMatch(/NOT EXISTS/)
    expect(claim).toMatch(/'held'/)
    expect(claim).toMatch(/'scheduled'/)
    expect(claim).toMatch(/SKIP LOCKED/)
  })
  it("is service-role only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION record_sms_flags\(UUID, BIGINT, JSONB, INT, INT\)\s+FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT\s+EXECUTE ON FUNCTION record_sms_flags\(UUID, BIGINT, JSONB, INT, INT\)\s+TO service_role/)
  })
})
