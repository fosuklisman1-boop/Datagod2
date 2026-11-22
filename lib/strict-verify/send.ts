import type { SupabaseClient } from "@supabase/supabase-js"
import type { MTNOrderRequest, MTNOrderResponse } from "@/lib/mtn-fulfillment"
import { getProviderDisplay } from "@/lib/mtn-providers/provider-display"
import { canCheck } from "./ask"
import type { Answer } from "./verdicts"

export const GATE_BUDGET_MS = 10_000

export interface StrictSendDeps {
  /** Suppliers in order. When pinned, exactly the admin's pick. */
  candidates: string[]
  pinned: boolean
  disabled: Set<string>
  fresh(phone: string, suppliers: string[]): Promise<Map<string, "yes" | "no">>
  ask(supplier: string, phone: string): Promise<Answer>
  save(rows: { phone: string; supplier: string; verdict: "yes" | "no" }[]): Promise<void>
  send(supplier: string, order: MTNOrderRequest): Promise<MTNOrderResponse>
  /** Whole-gate budget, measured from the start of strictSend. */
  budgetMs: number
}

/**
 * Candidates for a strict send: the pin alone, else the default provider then
 * the retry sequence (deduped, order kept). `disabled` is the admin kill list.
 */
export async function buildCandidates(
  _db: SupabaseClient,
  pin?: string
): Promise<{ candidates: string[]; disabled: Set<string> }> {
  const { getMTNProvider, getRetrySequence, getDisabledProviders } = await import("@/lib/mtn-providers/factory")
  const disabled = new Set<string>(await getDisabledProviders())
  if (pin) return { candidates: [pin], disabled }
  const primary = await getMTNProvider()
  const sequence = await getRetrySequence()
  const candidates: string[] = []
  for (const name of [primary.name, ...sequence]) if (!candidates.includes(name)) candidates.push(name)
  return { candidates, disabled }
}

const label = (supplier: string) => getProviderDisplay(supplier).label

/**
 * The strict gate: a supplier receives an MTN order only with its OWN "yes".
 * Never throws. Never logs or returns the phone number.
 */
export async function strictSend(order: MTNOrderRequest, deps: StrictSendDeps): Promise<MTNOrderResponse> {
  const started = Date.now()
  const phone = order.recipient_phone
  const traceId = order.traceId

  const refuse = (supplier: string, kind: "SUPPLIER_NOT_APPROVED" | "SUPPLIER_CHECK_UNAVAILABLE"): MTNOrderResponse => ({
    success: false,
    message:
      kind === "SUPPLIER_NOT_APPROVED"
        ? `${label(supplier)} hasn't approved this number`
        : `${label(supplier)} couldn't check this number right now`,
    traceId,
    error_type: kind,
  })

  const checkable = deps.candidates.filter((s) => canCheck(s, deps.disabled))
  let saved = new Map<string, "yes" | "no">()
  if (checkable.length > 0) {
    try {
      saved = await deps.fresh(phone, checkable)
    } catch {
      saved = new Map()
    }
  }

  // Only a CHECKABLE supplier that gave no answer makes the hold "unanswered";
  // otherwise (all said no, or nobody could check) the hold is "rejected".
  let unanswered = false
  let approvedFailure: MTNOrderResponse | null = null

  for (const supplier of deps.candidates) {
    let answer: Answer
    if (!canCheck(supplier, deps.disabled)) {
      // Strict mode: a supplier without a working check never receives the order.
      if (deps.pinned) return refuse(supplier, "SUPPLIER_CHECK_UNAVAILABLE")
      continue
    } else if (saved.has(supplier)) {
      answer = saved.get(supplier)!
    } else if (Date.now() - started >= deps.budgetMs) {
      answer = "no_answer"
    } else {
      try {
        answer = await deps.ask(supplier, phone)
      } catch {
        answer = "no_answer"
      }
      if (answer === "yes" || answer === "no") {
        try {
          await deps.save([{ phone, supplier, verdict: answer }])
        } catch {
          // a failed save never blocks the send decision
        }
      }
    }

    if (answer === "no") {
      if (deps.pinned) return refuse(supplier, "SUPPLIER_NOT_APPROVED")
      continue
    }
    if (answer === "no_answer") {
      if (deps.pinned) return refuse(supplier, "SUPPLIER_CHECK_UNAVAILABLE")
      unanswered = true
      continue
    }

    let result: MTNOrderResponse
    try {
      result = { ...(await deps.send(supplier, order)), provider: supplier }
    } catch {
      // A throw (timeout, abort, network) can come after the supplier already
      // created the order. Never try anyone else: that is the double-delivery path.
      return {
        success: false,
        message: `${label(supplier)} did not confirm the order — outcome unknown`,
        traceId,
        provider: supplier,
        error_type: "OUTCOME_UNKNOWN",
      }
    }
    if (result.success || result.error_type === "OUTCOME_UNKNOWN") return result
    approvedFailure = result
  }

  if (approvedFailure) return approvedFailure
  return {
    success: false,
    held: true,
    message: "No supplier has approved this number yet — order held",
    traceId,
    error_type: "STRICT_HOLD",
    strictHoldReason: unanswered ? "unanswered" : "rejected",
  }
}
