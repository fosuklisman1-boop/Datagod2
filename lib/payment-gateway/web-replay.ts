// R2 for web starts that keep no wallet_payments row to look a live attempt up by (SMS, storefront AFA): the open
// hubtel_payments rows themselves say whether this purchase already has a live attempt. payments/initialize has its own
// block, keyed on wallet_payments.order_id.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Gateway, SurfaceKey } from "./config"
import { HUBTEL_REPLAY_LOOKBACK_MS, pickHubtelReplay, type OpenAttemptReplayRow } from "./initialize-gateway"
import { getSurfaceConfig } from "./read-config"

/** Which of a surface's attempts belong to this purchase: a reference prefix (SMS) or the candidate order ids (AFA). */
export type AttemptFilter = { prefix: string } | { references: string[] }

export type ReplayDecision =
  | { kind: "fresh" }
  | { kind: "replay"; reference: string }
  | { kind: "refuse"; status: 409 | 503; body: { error: string; code: string } }

export const TRY_AGAIN_BODY = { error: "Could not start the payment. Please try again.", code: "try_again" }
const IN_PROGRESS_BODY = { error: "A payment for this order is still in progress. Finish it, or try again a little later.", code: "PAYMENT_IN_PROGRESS" }

interface OpenAttemptRow extends OpenAttemptReplayRow {
  reference: string | null
  created_at: string | null
}

async function surfaceSaysHubtel(surface: SurfaceKey): Promise<boolean> {
  try {
    return (await getSurfaceConfig(surface)).gateway === "hubtel"
  } catch {
    return true // Can't tell: a live attempt can't be ruled out either.
  }
}

/** The answer when a live attempt can't be ruled out: refuse on Hubtel; a surface on Paystack goes on as today. */
export async function replayUnknown(surface: SurfaceKey, gateway: Gateway): Promise<ReplayDecision> {
  if (gateway === "hubtel" || (await surfaceSaysHubtel(surface))) return { kind: "refuse", status: 503, body: TRY_AGAIN_BODY }
  return { kind: "fresh" }
}

/**
 * Does this purchase already have a live Hubtel attempt? A live one is replayed when the request resolved to Hubtel, and
 * refused otherwise: a Paystack prompt beside it could be paid too. One read, on Paystack as well, and the answer to a
 * failed read depends on the surface: on Hubtel a live attempt can't be ruled out, so it refuses; on Paystack it goes on
 * as today.
 */
export async function decideAttemptReplay(
  db: SupabaseClient,
  surface: SurfaceKey,
  gateway: Gateway,
  filter: AttemptFilter,
  nowMs: number = Date.now(),
): Promise<ReplayDecision> {
  if ("references" in filter && filter.references.length === 0) return { kind: "fresh" }
  let rows: OpenAttemptRow[] | null = null
  let failed = false
  try {
    const base = db
      .from("hubtel_payments")
      .select("reference, internal_reference, status, expires_at, mode, checkout_url, created_at")
      .eq("surface", surface)
      .in("status", ["pending", "confirming"])
      .gte("created_at", new Date(nowMs - HUBTEL_REPLAY_LOOKBACK_MS).toISOString())
    const scoped = "prefix" in filter ? base.like("internal_reference", `${filter.prefix}%`) : base.in("internal_reference", filter.references)
    const { data, error } = await scoped.order("created_at", { ascending: false }).limit(5)
    if (error) {
      console.error("[payment-replay] open attempt lookup failed:", error.code ?? "no code")
      failed = true
    } else {
      rows = (data ?? []) as OpenAttemptRow[]
    }
  } catch (e) {
    console.error("[payment-replay] open attempt lookup threw:", e instanceof Error ? e.message : "unknown error")
    failed = true
  }
  if (failed) return replayUnknown(surface, gateway)
  const live = pickHubtelReplay(
    (rows ?? []).map((r) => ({ id: r.reference ?? "", reference: r.internal_reference, payment_method: "hubtel", status: "pending", created_at: r.created_at })),
    nowMs,
    rows ?? [],
  )
  if (!live) return { kind: "fresh" }
  if (gateway !== "hubtel") return { kind: "refuse", status: 409, body: IN_PROGRESS_BODY }
  return { kind: "replay", reference: live.reference }
}
