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
/** How far back to look for a live attempt's row: an attempt can start up to 15 minutes after its row and live 60. */
export const HUBTEL_REPLAY_LOOKBACK_MS = 75 * 60 * 1000

export interface WalletPaymentReplayRow {
  id: string
  reference: string | null
  payment_method: string | null
  status: string | null
  created_at: string | null
}

export interface OpenAttemptReplayRow {
  internal_reference: string | null
  expires_at: string | null
  status: string | null
  mode: string | null
  checkout_url: string | null
}

/**
 * Does this open attempt still hold its order? `confirming` always does: a check is running and may find it paid.
 * Otherwise it holds until it expires, unless it is a checkout attempt with no link: start.ts never hands out a link it
 * couldn't store, so a null checkout_url means nobody received one. Anything unknown (no mode, no readable expiry) holds.
 */
function attemptHolds(a: OpenAttemptReplayRow, nowMs: number): boolean {
  if (a.status === "confirming") return true
  const expired = !!a.expires_at && new Date(a.expires_at).getTime() <= nowMs
  return !expired && (a.mode !== "checkout" || !!a.checkout_url)
}

/**
 * The newest pending Hubtel payment row for the order that is from the last 15 minutes, or whose own attempt still
 * holds the order (attemptHolds). `openAttempts` are hubtel_payments rows that are pending or confirming.
 */
export function pickHubtelReplay(
  rows: WalletPaymentReplayRow[] | null | undefined,
  nowMs: number,
  openAttempts: OpenAttemptReplayRow[] = [],
): { id: string; reference: string } | null {
  const held = (reference: string | null) => openAttempts.some((a) => a.internal_reference === reference && attemptHolds(a, nowMs))
  const live = (rows ?? []).filter((r) =>
    r.payment_method === "hubtel" && r.status === "pending" && !!r.reference && !!r.created_at &&
    (nowMs - new Date(r.created_at).getTime() <= HUBTEL_REPLAY_WINDOW_MS || held(r.reference)))
  live.sort((a, b) => new Date(b.created_at!).getTime() - new Date(a.created_at!).getTime())
  const top = live[0]
  return top ? { id: top.id, reference: top.reference! } : null
}
