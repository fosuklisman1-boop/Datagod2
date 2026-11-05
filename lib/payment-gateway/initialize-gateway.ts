// Gateway choice for app/api/payments/initialize, kept pure so the route only wires it.
import { normalizeGhanaPhone } from "@/lib/phone-format"
import type { FeeBearer, Gateway, SurfaceKey } from "./config"

export interface InitializeRequestKind {
  storefrontType: string | null
  /** A channel 'bots' commission row (wired in Task 6, not here). */
  botOrder: boolean
  orderId: string | null | undefined
  orderType: unknown
  isTopup: boolean
  isUpgrade: boolean
}

/**
 * Which surface's config decides the gateway. null keeps today's Paystack path exactly.
 * Upgrade and the results-check service are dashboard_direct; every other order is a shop order (storefront).
 */
export function initializeSurface(k: InitializeRequestKind): SurfaceKey | null {
  if (k.botOrder) return null
  if (k.isUpgrade) return "dashboard_direct"
  if (k.orderId && k.orderType === "results_check_service") return "dashboard_direct"
  if (k.orderId) return "storefront"
  if (k.isTopup) return "wallet_topup"
  return null
}

/** Paystack + customer bearer: today's fee. Paystack + merchant bearer: 0. Hubtel: 0 (Hubtel adds its own charge). */
export function initializeFee(i: { surface: SurfaceKey | null; gateway: Gateway; feeBearer: FeeBearer; standardFee: number }): number {
  if (!i.surface) return i.standardFee
  if (i.gateway === "hubtel" || i.feeBearer === "merchant") return 0
  return i.standardFee
}

/**
 * A web direct charge on Hubtel may only prompt a number that proved itself: an SMS-OTP verified number, or the
 * logged-in user's own verified number. Any lookup failure counts as not verified.
 */
export async function isVerifiedWebPayer(
  phone: string,
  deps: { isPhoneOtpVerified: (phone: string) => Promise<boolean>; ownVerifiedPhone: () => Promise<string | null> },
): Promise<boolean> {
  const payer = normalizeGhanaPhone(phone)
  if (!payer) return false
  try {
    if (await deps.isPhoneOtpVerified(phone)) return true
  } catch {
    // fall through to the account's own number
  }
  try {
    const own = await deps.ownVerifiedPhone()
    return !!own && normalizeGhanaPhone(own) === payer
  } catch {
    return false
  }
}

/**
 * paymentPhone comes straight from the request body and may be anything. Only a string or a number can be a phone
 * number; everything else is "" (no number), never a throw: String() throws on a body like {"toString":1}.
 */
export function momoPhoneText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number") return String(value)
  return ""
}

/** Same window as lib/bot-commission/momo.ts's replay. */
export const HUBTEL_REPLAY_WINDOW_MS = 15 * 60 * 1000
/** How far back to look for a live attempt: a hosted attempt lives 60 minutes (start.ts). */
export const HUBTEL_REPLAY_LOOKBACK_MS = 60 * 60 * 1000

export interface WalletPaymentReplayRow {
  id: string
  reference: string | null
  payment_method: string | null
  status: string | null
  created_at: string | null
}

/**
 * The newest pending Hubtel payment row for the order that is from the last 15 minutes, or whose own attempt is still
 * open and unexpired (a hosted link lives longer than the window). `openAttempts` are hubtel_payments rows.
 */
export function pickHubtelReplay(
  rows: WalletPaymentReplayRow[] | null | undefined,
  nowMs: number,
  openAttempts: { internal_reference: string | null; expires_at: string | null }[] = [],
): { id: string; reference: string } | null {
  const attemptLive = (reference: string | null) => openAttempts.some((a) =>
    a.internal_reference === reference && !!a.expires_at && new Date(a.expires_at).getTime() > nowMs)
  const live = (rows ?? []).filter((r) =>
    r.payment_method === "hubtel" && r.status === "pending" && !!r.reference && !!r.created_at &&
    (nowMs - new Date(r.created_at).getTime() <= HUBTEL_REPLAY_WINDOW_MS || attemptLive(r.reference)))
  live.sort((a, b) => new Date(b.created_at!).getTime() - new Date(a.created_at!).getTime())
  const top = live[0]
  return top ? { id: top.id, reference: top.reference! } : null
}
