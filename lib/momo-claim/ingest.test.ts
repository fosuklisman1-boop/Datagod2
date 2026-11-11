import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ingestForwardedSms, MomoStoreError } from "./ingest"
import { makeFakeDb } from "./fake-db.test-helper"
import type { MomoClaimSettings } from "./settings"
import type { MomoAdminAlert } from "@/lib/admin-actions/momo-claim"

const settings = (over: Partial<MomoClaimSettings> = {}): MomoClaimSettings => ({
  enabled: true,
  accounts: [],
  accountName: "",
  feeCustomerPercent: 0,
  feeDealerPercent: 0,
  minNetPesewas: 1000,
  maxSentPesewas: 200000,
  senderAllowlist: ["MobileMoney"],
  regressionThreshold: 1000000,
  reviewThresholdPesewas: 50000,
  dailyCapPesewas: 300000,
  ...over,
})

const TXID = "80000000123"
const payment = (opts: { ref?: string; amount?: string; txid?: string; balance?: string } = {}) =>
  `Payment received for GHS ${opts.amount ?? "50.00"} from JANE DOE Current Balance GHS ${opts.balance ?? "272.65"} Available Balance GHS 272.65. ` +
  `Reference: ${opts.ref ?? "KXR4829"}. Transaction ID: ${opts.txid ?? TXID}.`

const FUTURE = () => new Date(Date.now() + 30 * 60_000).toISOString()
const PAST = () => new Date(Date.now() - 60_000).toISOString()
const session = (code: string, over: Record<string, unknown> = {}) => ({
  id: `sess-${code}`,
  code,
  status: "pending",
  expires_at: FUTURE(),
  ...over,
})

let alerts: MomoAdminAlert[]
const notifyAdmins = async (a: MomoAdminAlert) => {
  alerts.push(a)
}
const run = (client: never, text: string, from: string | null = "MobileMoney", s = settings()) =>
  ingestForwardedSms(client, { text, from }, s, { notifyAdmins })

let logSpies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  alerts = []
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
})
afterEach(() => {
  // No console method may ever receive SMS content, names or a full transaction ID.
  for (const spy of logSpies) {
    const dump = JSON.stringify(spy.mock.calls)
    expect(dump).not.toContain("JANE DOE")
    expect(dump).not.toContain("Payment received")
    expect(dump).not.toContain(TXID)
    expect(dump).not.toContain("KXR4829")
    spy.mockRestore()
  }
})

describe("ingestForwardedSms", () => {
  it("stores a non-allowlisted sender as rejected_sender without parsing or alerting", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    const out = await run(client, payment(), "  +233200000000 ")
    expect(out).toBe("rejected_sender")
    const rows = db.tables.momo_transactions
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("rejected_sender")
    expect(String(rows[0].transaction_id)).toMatch(/^X[0-9a-f-]{36}$/)
    expect(rows[0].raw_sms).toBe(payment())
    expect(rows[0].sms_sender).toBe("+233200000000")
    expect(rows[0].amount ?? null).toBeNull()
    expect(rows[0].sender_name ?? null).toBeNull()
    expect(db.rpcCalls).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  it("treats a null sender as not allowlisted", async () => {
    const { db, client } = makeFakeDb()
    expect(await run(client, payment(), null)).toBe("rejected_sender")
    expect(db.tables.momo_transactions[0].status).toBe("rejected_sender")
  })

  it("matches the allowlist exactly after trimming", async () => {
    const { client } = makeFakeDb()
    expect(await run(client, payment(), "mobilemoney")).toBe("rejected_sender")
    expect(await run(client, payment({ txid: "80000000124" }), " MobileMoney ")).not.toBe("rejected_sender")
  })

  it("ignores text failing the prefilter and stores nothing", async () => {
    const { db, client } = makeFakeDb()
    expect(await run(client, "Your OTP is 123456")).toBe("ignored")
    expect(db.tables.momo_transactions).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  it("ignores empty and over-long text and stores nothing", async () => {
    const { db, client } = makeFakeDb()
    expect(await run(client, "   ")).toBe("ignored")
    expect(await run(client, payment() + " ".repeat(2001))).toBe("ignored")
    expect(await run(client, "x".repeat(2001), "Someone")).toBe("ignored")
    expect(db.tables.momo_transactions).toHaveLength(0)
  })

  it("stores an unrecognised MoMo-looking SMS as unparsed and alerts admins", async () => {
    const { db, client } = makeFakeDb()
    const text = "You have GHS 5 bonus. Transaction ID: 123"
    expect(await run(client, text)).toBe("unparsed")
    const rows = db.tables.momo_transactions
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("unparsed")
    expect(String(rows[0].transaction_id)).toMatch(/^X[0-9a-f-]{36}$/)
    expect(rows[0].raw_sms).toBe(text)
    expect(alerts).toEqual([{ kind: "unparsed" }])
  })

  it("stores a parsed SMS as pending with GHS amounts", async () => {
    const { db, client } = makeFakeDb()
    expect(await run(client, payment({ ref: "nothing" }))).toBe("stored_pending")
    expect(db.tables.momo_transactions[0]).toMatchObject({
      transaction_id: TXID,
      status: "pending",
      amount: 50,
      sms_balance: 272.65,
      sender_name: "JANE DOE",
      sms_sender: "MobileMoney",
      network: "MTN",
      pattern: "mtn_payment",
      raw_sms: payment({ ref: "nothing" }),
    })
  })

  it("returns duplicate for a txid already stored and does nothing else", async () => {
    const { db, client } = makeFakeDb({
      momo_transactions: [{ transaction_id: TXID, status: "claimed", flag_reasons: [] }],
      wallet_topup_sessions: [session("KXR4829")],
    })
    expect(await run(client, payment())).toBe("duplicate")
    expect(db.tables.momo_transactions).toHaveLength(1)
    expect(db.rpcCalls).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  it("flags above-max, alerts with last 4 txid digits only, and never calls the RPC", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    const out = await run(client, payment({ amount: "2,500.00" }))
    expect(out).toBe("flagged")
    const row = db.tables.momo_transactions[0]
    expect(row.status).toBe("flagged")
    expect(row.flag_reasons).toEqual(["above_max"])
    expect(db.rpcCalls).toHaveLength(0)
    expect(alerts).toEqual([{ kind: "flagged", amountPesewas: 250000, txidLast4: "0123", reasons: ["above_max"] }])
  })

  it("flags a txid regression against the largest numeric txid of other pending/claimed rows", async () => {
    const { db, client } = makeFakeDb({
      momo_transactions: [
        // Lexically larger but numerically smaller: must not be chosen.
        { transaction_id: "99999999", status: "claimed", flag_reasons: [] },
        { transaction_id: "80002000123", status: "pending", flag_reasons: [] },
        // Larger but in a status that does not count.
        { transaction_id: "999999999999999", status: "flagged", flag_reasons: [] },
        { transaction_id: "Xabc", status: "unparsed", flag_reasons: [] },
      ],
      wallet_topup_sessions: [session("KXR4829")],
    })
    expect(await run(client, payment())).toBe("flagged")
    const row = db.tables.momo_transactions.find((r) => r.transaction_id === TXID)!
    expect(row.flag_reasons).toEqual(["txid_regression"])
    expect(db.rpcCalls).toHaveLength(0)
  })

  it("does not flag a regression within the threshold", async () => {
    const { db, client } = makeFakeDb({
      momo_transactions: [{ transaction_id: "80000500123", status: "claimed", flag_reasons: [] }],
    })
    expect(await run(client, payment({ ref: "none" }))).toBe("stored_pending")
    expect(db.tables.momo_transactions.find((r) => r.transaction_id === TXID)!.status).toBe("pending")
  })

  it("flags a balance already seen on another txid", async () => {
    const { db, client } = makeFakeDb({
      momo_transactions: [{ transaction_id: "70000000001", status: "voided", sms_balance: 272.65, flag_reasons: [] }],
    })
    expect(await run(client, payment())).toBe("flagged")
    expect(db.tables.momo_transactions.find((r) => r.transaction_id === TXID)!.flag_reasons).toEqual(["balance_repeat"])
  })

  it("flags (fails closed) when the intake state cannot be read", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.failSelect.add("momo_transactions")
    expect(await run(client, payment())).toBe("flagged")
    expect(db.tables.momo_transactions[0].flag_reasons).toEqual(["intake_check_error"])
    expect(db.rpcCalls).toHaveLength(0)
    expect(alerts[0]).toMatchObject({ kind: "flagged", reasons: ["intake_check_error"] })
  })

  it("still alerts when the flag update fails, and never calls the RPC", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.failUpdate = true
    expect(await run(client, payment({ amount: "2,500.00" }))).toBe("flagged")
    expect(db.rpcCalls).toHaveLength(0)
    expect(alerts[0]).toMatchObject({ kind: "flagged", reasons: ["above_max", "flag_update_failed"] })
  })

  it("auto-credits when exactly one live code is in the text", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.rpcImpl = () => ({ data: "credited", error: null })
    expect(await run(client, payment({ ref: "kxr-4829" }))).toBe("credited")
    expect(db.rpcCalls).toEqual([
      { name: "claim_via_wallet_topup_session", args: { p_code: "KXR4829", p_txid: TXID } },
    ])
    expect(alerts).toEqual([{ kind: "credited", amountPesewas: 5000, txidLast4: "0123" }])
  })

  it("returns under_review and alerts with the row's flag reasons", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.rpcImpl = (_n, args, d) => {
      const row = d.tables.momo_transactions.find((r) => r.transaction_id === args.p_txid)!
      row.status = "flagged"
      row.flag_reasons = ["amount_mismatch"]
      return { data: "under_review", error: null }
    }
    expect(await run(client, payment())).toBe("under_review")
    expect(db.rpcCalls).toHaveLength(1)
    expect(alerts).toEqual([{ kind: "flagged", amountPesewas: 5000, txidLast4: "0123", reasons: ["amount_mismatch"] }])
  })

  it.each(["no_session", "already_credited", "not_matched", null])("maps RPC result %s to stored_pending", async (res) => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.rpcImpl = () => ({ data: res, error: null })
    expect(await run(client, payment())).toBe("stored_pending")
    expect(alerts).toHaveLength(0)
  })

  it("leaves the row pending with no RPC when no code is present", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    expect(await run(client, payment({ ref: "JANE" }))).toBe("stored_pending")
    expect(db.rpcCalls).toHaveLength(0)
    expect(db.tables.momo_transactions[0].status).toBe("pending")
  })

  it("does not auto-credit when two different live codes appear", async () => {
    const { db, client } = makeFakeDb({
      wallet_topup_sessions: [session("KXR4829"), session("ABC2345")],
    })
    expect(await run(client, payment({ ref: "KXR4829 ABC2345" }))).toBe("stored_pending")
    expect(db.rpcCalls).toHaveLength(0)
  })

  it("auto-credits when only one of two candidates is a live session", async () => {
    const { db, client } = makeFakeDb({
      wallet_topup_sessions: [
        session("KXR4829"),
        session("ABC2345", { expires_at: PAST() }),
        session("DEF2345", { status: "claimed" }),
      ],
    })
    db.rpcImpl = () => ({ data: "credited", error: null })
    expect(await run(client, payment({ ref: "KXR4829 ABC2345 DEF2345" }))).toBe("credited")
    expect(db.rpcCalls).toHaveLength(1)
    expect(db.rpcCalls[0].args.p_code).toBe("KXR4829")
  })

  it("does not call the RPC for expired or non-pending sessions", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829", { expires_at: PAST() })] })
    expect(await run(client, payment())).toBe("stored_pending")
    expect(db.rpcCalls).toHaveLength(0)
  })

  it("catches an RPC error, leaves the row pending and alerts auto_credit_error", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.rpcImpl = () => ({ data: null, error: { message: "NO_WALLET" } })
    expect(await run(client, payment())).toBe("stored_pending")
    expect(db.tables.momo_transactions[0].status).toBe("pending")
    expect(alerts).toEqual([{ kind: "flagged", amountPesewas: 5000, txidLast4: "0123", reasons: ["auto_credit_error"] }])
  })

  it("catches a thrown RPC error the same way", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.rpcImpl = () => {
      throw new Error("network")
    }
    expect(await run(client, payment())).toBe("stored_pending")
    expect(alerts[0]).toMatchObject({ kind: "flagged", reasons: ["auto_credit_error"] })
  })

  it("feature disabled: still stores and flags but never calls the RPC", async () => {
    const { db, client } = makeFakeDb({ wallet_topup_sessions: [session("KXR4829")] })
    db.rpcImpl = () => ({ data: "credited", error: null })
    expect(await run(client, payment(), "MobileMoney", settings({ enabled: false }))).toBe("stored_pending")
    expect(db.tables.momo_transactions[0].status).toBe("pending")
    expect(await run(client, payment({ txid: "80000000200", amount: "3000.00", balance: "1.00" }), "MobileMoney", settings({ enabled: false }))).toBe("flagged")
    expect(db.rpcCalls).toHaveLength(0)
  })

  it("throws MomoStoreError when a row cannot be stored", async () => {
    for (const [text, from] of [
      [payment(), "MobileMoney"],
      [payment(), "Stranger"],
      ["GHS Transaction ID odd", "MobileMoney"],
    ] as const) {
      const { db, client } = makeFakeDb()
      db.failInsert = true
      await expect(run(client, text, from)).rejects.toBeInstanceOf(MomoStoreError)
    }
  })
})
