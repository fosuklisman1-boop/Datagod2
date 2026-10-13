import { createHash } from "crypto"
import type { HubtelCsServiceKey } from "@/lib/hubtel-cs/services"
import type { HubtelCsTx, HubtelQueryItem } from "@/lib/hubtel-cs/types"
import type { PurchaseInput } from "@/lib/hubtel-cs/client"
import { HubtelDuplicateOrderError, HubtelOutcomeUnknownError } from "@/lib/hubtel-cs/errors"
import {
  BILLERS, isBillerKey, normaliseInputs, lookupRequest, parseLookup, suggestedAmount, purchaseFields,
  type BillerKey, type BillInputs,
} from "./billers"
import { checkBillAmount, type BillsConfig } from "./config"
import { signBillToken, verifyBillToken, type VerifiedBill } from "./token"

export interface BillOrderRow {
  id: string; reference_code: string; user_id: string; biller: BillerKey; account_number: string; phone: string | null
  email: string | null; broadband_account: string | null; session_id: string | null; customer_name: string | null
  verified: boolean; amount: number; status: "pending" | "processing" | "completed" | "failed" | "refunded"
  payment_status: "unpaid" | "paid" | "refunded"; hubtel_client_reference: string | null; commission: number | null
  failure_reason: string | null; notes: string | null; created_at: string; updated_at: string
}

export interface BillsDeps {
  getBillsConfig(): Promise<BillsConfig>
  getHubtelConfig(): Promise<{ enabled: boolean; paused: boolean; services: Record<string, boolean> }>
  query(serviceKey: HubtelCsServiceKey, destination: string, params?: { mobile?: string }):
    Promise<{ ok: true; data: HubtelQueryItem[] } | { ok: false; error: string; code?: string }>
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  insertOrder(row: Omit<BillOrderRow, "id" | "created_at" | "updated_at" | "hubtel_client_reference" | "commission" | "failure_reason" | "notes"> & { verify_token_hash: string }): Promise<BillOrderRow>
  getOrder(id: string): Promise<BillOrderRow | null>
  updateOrder(id: string, patch: Partial<BillOrderRow>, onlyFromStatuses?: BillOrderRow["status"][]): Promise<number>
  /** Atomic: lock order, deduct wallet, mark paid, write history. Throws on RPC error (outcome unknown). */
  debitOrder(orderId: string): Promise<"ok" | "insufficient" | "not_found">
  /** `urgent` alerts keep the email fallback when SMS cannot be sent. */
  alert(message: string, urgent?: boolean): Promise<void>
  newReference(): string
  secret: string
  now(): number
}

export type VerifyResult =
  | { ok: true; customerName: string | null; amountDue: number | null; suggestedAmount: number; token?: string;
      meters?: { meter: string; name: string | null; outstanding: number | null; token: string }[] }
  | { ok: false; status: number; error: string }

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })
const safeAlert = async (d: BillsDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* alerting must never break the flow */ } }
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Reads both configs; null on any failure => callers fail closed. */
async function gate(d: BillsDeps, biller: BillerKey): Promise<
  { ok: true; bills: BillsConfig } | { ok: false; status: number; error: string }
> {
  let bills: BillsConfig
  try { bills = await d.getBillsConfig() } catch { return fail(503, "Temporarily unavailable") }
  if (!bills.enabled || !bills.billers[biller]?.enabled) return fail(403, "This biller is not available")
  return { ok: true, bills }
}

async function hubtelGate(d: BillsDeps, biller: BillerKey, opts: { checkPause: boolean }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const h = await d.getHubtelConfig()
    if (!h.enabled || h.services?.[BILLERS[biller].serviceKey] !== true || (opts.checkPause && h.paused)) {
      return fail(503, "Temporarily unavailable")
    }
    return { ok: true }
  } catch {
    return fail(503, "Temporarily unavailable")
  }
}

export async function verifyBill(
  d: BillsDeps, userId: string, biller: string, inputs: BillInputs & { addMeter?: boolean; consent?: boolean },
): Promise<VerifyResult> {
  if (!isBillerKey(biller)) return fail(400, "Unknown biller")
  if (!d.secret) return fail(503, "Temporarily unavailable")
  const g = await gate(d, biller)
  if (!g.ok) return g
  const hg = await hubtelGate(d, biller, { checkPause: false })
  if (!hg.ok) return hg
  const n = normaliseInputs(biller, inputs)
  if (!n.ok) return fail(400, n.error)
  const v = n.value
  const addMeter = biller === "ecg" && inputs.addMeter === true
  if (addMeter && !v.account) return fail(400, "Enter the meter or account number")
  if (addMeter && inputs.consent !== true) return fail(400, "Tick to confirm linking this meter to your payment before continuing")
  const req = lookupRequest(biller, v)
  let res: Awaited<ReturnType<BillsDeps["query"]>>
  try {
    res = await d.query(BILLERS[biller].serviceKey, req.destination, req.mobile ? { mobile: req.mobile } : undefined)
  } catch (e) {
    console.error("[bills] lookup threw:", msg(e))
    return fail(422, "Couldn't verify this account right now")
  }
  if (!res.ok) return fail(422, `Couldn't verify this account: ${res.error}`)
  const parsed = parseLookup(biller, res.data)
  const issuedAt = d.now()
  const base = { userId, biller, phone: v.phone, email: v.email, broadbandAccount: v.broadbandAccount, issuedAt }
  const sign = (t: Omit<VerifiedBill, keyof typeof base>) => signBillToken({ ...base, ...t }, d.secret)

  if (biller === "ecg") {
    if (!addMeter) {
      const meters = parsed.meters.map(m => ({
        meter: m.meter, name: m.name, outstanding: m.outstanding,
        token: sign({ account: m.meter, sessionId: null, customerName: m.name, verified: true }),
      }))
      return { ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters }
    }
    const hit = parsed.meters.find(m => m.meter.toLowerCase() === v.account.toLowerCase())
    const token = sign({ account: hit ? hit.meter : v.account, sessionId: null, customerName: hit?.name ?? null, verified: !!hit })
    return { ok: true, customerName: hit?.name ?? null, amountDue: hit?.outstanding ?? null, suggestedAmount: suggestedAmount(hit?.outstanding ?? null), token }
  }
  if (biller === "ghana_water" && !parsed.sessionId) {
    return fail(422, "Couldn't verify this account: no session returned for this meter")
  }
  const token = sign({ account: v.account, sessionId: parsed.sessionId, customerName: parsed.customerName, verified: true })
  return { ok: true, customerName: parsed.customerName, amountDue: parsed.amountDue, suggestedAmount: suggestedAmount(parsed.amountDue), token }
}

export type PayResult = { ok: true; order: BillOrderRow } | { ok: false; status: number; error: string; order?: BillOrderRow }

export async function payBill(d: BillsDeps, userId: string, token: string, amount: number): Promise<PayResult> {
  if (!d.secret) return fail(503, "Temporarily unavailable")
  const v = verifyBillToken(token, d.secret, userId, d.now())
  if (!v) return fail(400, "Please verify the account again")
  // Every pre-debit check happens before the first write.
  const g = await gate(d, v.biller)
  if (!g.ok) return g
  const bad = checkBillAmount(g.bills.billers[v.biller], amount)
  if (bad) return fail(400, bad)
  const pay = Math.round(amount * 100) / 100
  const hg = await hubtelGate(d, v.biller, { checkPause: true })
  if (!hg.ok) return hg

  let order: BillOrderRow
  try {
    order = await d.insertOrder({
      reference_code: d.newReference(), user_id: userId, biller: v.biller, account_number: v.account, phone: v.phone,
      email: v.email, broadband_account: v.broadbandAccount, session_id: v.sessionId, customer_name: v.customerName,
      verified: v.verified, amount: pay, status: "pending", payment_status: "unpaid",
      verify_token_hash: createHash("sha256").update(token).digest("hex"),
    })
  } catch (e: any) {
    if (e?.code === "23505") return fail(409, "This verification was already used — please verify again")
    return fail(500, "Could not create the order")
  }

  let debit: "ok" | "insufficient" | "not_found" | null = null
  try {
    debit = await d.debitOrder(order.id)
  } catch {
    // Outcome unknown: believe only the database.
    let fresh: BillOrderRow | null = null
    try { fresh = await d.getOrder(order.id) } catch { fresh = null }
    if (fresh && fresh.payment_status === "paid") {
      debit = "ok"
    } else {
      await safeAlert(d, `Bill debit outcome uncertain: order ${order.reference_code}, user ${userId}, GHS ${pay} — check wallet`, true)
      return { ok: false, status: 500, error: "We could not confirm your payment. Please check your wallet before retrying.", order }
    }
  }
  if (debit === "not_found") return { ok: false, status: 409, error: "This order can no longer be paid", order }
  if (debit === "insufficient") {
    const patch = { status: "failed" as const, failure_reason: "Insufficient wallet balance" }
    await d.updateOrder(order.id, patch, ["pending"]).catch(() => 0)
    return { ok: false, status: 402, error: "Insufficient wallet balance", order: { ...order, ...patch } }
  }
  order = { ...order, payment_status: "paid" }
  if (g.bills.autoFulfil) {
    const r = await dispatchInternal(d, order)
    order = { ...order, ...r.patch, status: r.status }
  }
  return { ok: true, order }
}

const DISPATCHING = "Dispatching…"

async function dispatchInternal(d: BillsDeps, order: BillOrderRow): Promise<{ status: BillOrderRow["status"]; patch: Partial<BillOrderRow> }> {
  if (order.status !== "pending" || order.payment_status !== "paid") return { status: order.status, patch: {} }
  const ref = order.reference_code
  try {
    const fresh = await d.getOrder(order.id)
    if (!fresh || fresh.status !== "pending" || fresh.payment_status !== "paid") return { status: fresh?.status ?? order.status, patch: {} }
    order = fresh
  } catch (e) {
    await safeAlert(d, `Bill order ${ref}: could not re-read the order before dispatch (${msg(e)}). It was paid and not sent; check it in Utility Bills.`)
    return { status: order.status, patch: {} }
  }
  const guarded = async (patch: Partial<BillOrderRow>, from: BillOrderRow["status"][]) => {
    try { return await d.updateOrder(order.id, patch, from) } catch { return 0 }
  }
  let claimed = false
  try {
    const pf = purchaseFields(order.biller, {
      account: order.account_number, phone: order.phone, email: order.email,
      broadbandAccount: order.broadband_account, sessionId: order.session_id,
    })
    const input: PurchaseInput = {
      serviceKey: BILLERS[order.biller].serviceKey, destination: pf.destination, amount: order.amount,
      ...(pf.bundle !== undefined ? { bundle: pf.bundle } : {}), ...(pf.extra ? { extra: pf.extra } : {}),
      orderTable: "hubtel_bill_orders", orderId: order.id,
    }
    // Atomic claim BEFORE purchase: whoever flips pending -> processing owns the send. A concurrent dispatch or an
    // admin refund (which needs status pending) loses here instead of racing the Hubtel call.
    const claimPatch: Partial<BillOrderRow> = { status: "processing", notes: DISPATCHING }
    if ((await guarded(claimPatch, ["pending"])) === 0) return { status: order.status, patch: {} }
    claimed = true

    let tx: HubtelCsTx
    try {
      tx = await d.purchase(input)
    } catch (e) {
      if (e instanceof HubtelDuplicateOrderError) {
        const patch: Partial<BillOrderRow> = { notes: "A live Hubtel transaction already exists for this order; do not resend." }
        await guarded(patch, ["processing"])
        await safeAlert(d, `Bill order ${ref}: a live Hubtel transaction exists but the order has no reference — check the Hubtel review queue; do not resend.`)
        return { status: "processing", patch }
      }
      if (e instanceof HubtelOutcomeUnknownError) {
        const patch: Partial<BillOrderRow> = {
          hubtel_client_reference: e.clientReference,
          notes: `Outcome unknown, do not resend. Hubtel ref ${e.clientReference}`,
        }
        const n = await guarded(patch, ["processing"])
        await safeAlert(d, `Bill order ${ref}: Hubtel outcome unknown (ref ${e.clientReference}), do not resend.${n === 0 ? " The order record could not be updated." : ""}`)
        return { status: "processing", patch: n === 0 ? {} : patch }
      }
      // Raised before the POST: nothing was sent. Release the claim back to pending for an admin.
      const patch: Partial<BillOrderRow> = { status: "pending", notes: `Not sent: ${msg(e)}` }
      const n = await guarded(patch, ["processing"])
      if (n === 0) return { status: order.status, patch: {} }
      await safeAlert(d, `Bill order ${ref} was paid but NOT sent to Hubtel: ${msg(e)}`)
      return { status: "pending", patch }
    }
    if (tx.state === "fulfilled") return { status: "completed", patch: {} }
    if (tx.state === "failed") return { status: "failed", patch: {} }
    const patch: Partial<BillOrderRow> = { hubtel_client_reference: tx.client_reference, notes: null }
    if (tx.state === "needs_review") {
      patch.notes = `Outcome unknown, do not resend. Hubtel ref ${tx.client_reference}`
      await safeAlert(d, `Bill order ${ref}: Hubtel outcome unknown (ref ${tx.client_reference}), do not resend.`)
    }
    const n = await guarded(patch, ["processing"])
    if (n === 0) {
      // A fast callback may already have settled the order: believe the database, not the failed write.
      let cur: BillOrderRow | null = null
      try { cur = await d.getOrder(order.id) } catch { cur = null }
      if (cur && !(cur.status === "processing" && !cur.hubtel_client_reference)) return { status: cur.status, patch: {} }
      await safeAlert(d, `Bill order ${ref}: Hubtel has the transaction (ref ${tx.client_reference}) but the order could not be updated. Reconcile manually; do not resend.`)
      return { status: cur?.status ?? order.status, patch: {} }
    }
    return { status: "processing", patch }
  } catch (e) {
    await safeAlert(d, `Bill order ${ref}: dispatch error ${msg(e)}${claimed ? " (order left processing; reconcile manually)" : ""}`)
    return { status: claimed ? "processing" : order.status, patch: {} }
  }
}

export async function dispatchBillOrder(d: BillsDeps, order: BillOrderRow): Promise<BillOrderRow["status"]> {
  return (await dispatchInternal(d, order)).status
}
