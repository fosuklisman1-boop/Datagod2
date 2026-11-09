// lib/refunds/hubtel-send-callback.ts
// Hubtel Send Money callback. Hubtel never signs callbacks, so the per-refund HMAC in the callback URL (which only
// we can build) is the only authentication. The BODY IS NEVER READ: a valid callback only names a refund, and the
// outcome comes from Hubtel's status check (the same one the reconcile cron uses), so a forged or wrong body can
// neither complete nor fail a refund. Every authenticated request answers 200 so Hubtel stops retrying; the reconcile
// cron is the backstop for anything that throws here.
import { verifySendSig } from "./hubtel-send-client"
import { reconcileRefund, type RefundDeps, type StoredRefund } from "./service"

export interface HubtelSendCallbackInput {
  ref: string | null
  sig: string | null
  secret: string | undefined
  loadRefund(id: string): Promise<StoredRefund | null>
}

export interface HubtelSendCallbackResult {
  status: number
  body: Record<string, unknown>
}

const REF_RE = /^[0-9a-f]{32}$/
const TAG = "[HUBTEL-SEND-CALLBACK]"
const ACK = (extra: Record<string, unknown> = {}): HubtelSendCallbackResult => ({ status: 200, body: { received: true, ...extra } })

/** The refund UUID behind a 32-hex send reference (the inverse of sendRefundReference), or null. */
export function refundIdFromSendRef(ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !REF_RE.test(ref)) return null
  return `${ref.slice(0, 8)}-${ref.slice(8, 12)}-${ref.slice(12, 16)}-${ref.slice(16, 20)}-${ref.slice(20)}`
}

export async function handleHubtelSendCallback(deps: RefundDeps, input: HubtelSendCallbackInput): Promise<HubtelSendCallbackResult> {
  const refundId = refundIdFromSendRef(input.ref)
  if (!refundId) return { status: 401, body: { error: "unauthorized" } }
  if (!input.secret || input.secret.length < 32) {
    console.error(`${TAG} HUBTEL_PAYMENTS_CALLBACK_SECRET is not configured (must be at least 32 chars); callback not processed`)
    return { status: 503, body: { error: "not configured" } }
  }
  if (!verifySendSig(input.ref, input.sig, input.secret)) {
    console.warn(`${TAG} bad signature for refund ${refundId}`)
    return { status: 401, body: { error: "unauthorized" } }
  }

  try {
    const stored = await input.loadRefund(refundId)
    if (!stored || stored.gateway !== "hubtel_send") return ACK({ ignored: "unknown refund" })
    // `reserved` means the original send request may still be running: leave it to that request (and the cron).
    if (stored.status !== "processing") return ACK({ ignored: "not awaiting a payout result" })
    // `processing` means the send call has returned and been recorded, so the 5-minute in-flight wait is not needed.
    const settled = await reconcileRefund(deps, stored, { skipInFlightGuard: true })
    console.log(`${TAG} refund ${refundId} -> ${settled.status}`)
  } catch (err) {
    // Refund id and error class only: never the message (it can echo a number) and never the callback body.
    console.error(`${TAG} status check or settle failed for refund ${refundId}: ${err instanceof Error ? err.name : "unknown"}`)
  }
  return ACK()
}
