import type { NextRequest } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { verifyTurnstileToken, getRequestIp, isTurnstileEnabled } from "@/lib/turnstile"
import { isStorefrontOtpRequired, isPhoneOtpVerified } from "@/lib/storefront-otp"
import { verifyShopSession } from "@/lib/shop-token"
import { getBillsRuntime, getBillsAvailability } from "@/lib/bills/runtime"
import { getBundlesRuntime, getBundlesAvailability } from "@/lib/standard-bundles/runtime"
import type { AvailabilityDeps, CapDeps } from "./shop"
import type { StorefrontBillsDeps, StorefrontOrderRow } from "./bills"
import type { StorefrontBundleRow, StorefrontBundlesDeps } from "./bundles"

/** Columns an initialize response is built from (StorefrontOrderRow). */
const ORDER_ROW = "id, reference_code, amount, paid_amount, payment_fee_amount, cashback_amount"
const BUNDLE_ROW = ORDER_ROW

/** Atomic limiter + DB backup counts for the pending-unpaid caps. DB errors count as 0 (fail open, like airtime). */
export function capDeps(request: NextRequest, db: SupabaseClient): CapDeps {
  return {
    limit: async (name, max, windowMs, id) => (await applyRateLimit(request, name, max, windowMs, id)).allowed,
    async countPending(table, column, value, sinceIso) {
      try {
        const { count, error } = await db
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("channel", "storefront")
          .eq(column, value)
          .eq("status", "pending")
          .eq("payment_status", "unpaid")
          .gte("created_at", sinceIso)
        return error ? 0 : count ?? 0
      } catch {
        return 0
      }
    },
    now: Date.now,
  }
}

export function getStorefrontBillsRuntime(request: NextRequest): { deps: StorefrontBillsDeps; db: SupabaseClient } {
  const { deps, db } = getBillsRuntime()
  return {
    db,
    deps: {
      ...deps,
      async insertStorefrontOrder(row) {
        const { data, error } = await db.from("hubtel_bill_orders").insert(row).select(ORDER_ROW).single()
        if (error) throw error // 23505 => the service returns the token's existing order or retries the reference
        return data as StorefrontOrderRow
      },
      async findStorefrontOrderByHash(shopId, verifyTokenHash) {
        const { data, error } = await db
          .from("hubtel_bill_orders")
          .select(ORDER_ROW)
          .eq("channel", "storefront")
          .eq("shop_id", shopId)
          .eq("verify_token_hash", verifyTokenHash)
          .maybeSingle()
        if (error) throw error
        return (data as StorefrontOrderRow | null) ?? null
      },
      caps: capDeps(request, db),
    },
  }
}


export function getStorefrontBundlesRuntime(request: NextRequest): { deps: StorefrontBundlesDeps; db: SupabaseClient } {
  const { deps, db } = getBundlesRuntime()
  return {
    db,
    deps: {
      ...deps,
      async findStorefrontOrder(shopId, idempotencyKey) {
        const { data, error } = await db
          .from("hubtel_data_orders")
          .select(BUNDLE_ROW)
          .eq("channel", "storefront")
          .eq("shop_id", shopId)
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle()
        if (error) throw error
        return (data as StorefrontBundleRow | null) ?? null
      },
      async insertStorefrontOrder(row) {
        const { data, error } = await db.from("hubtel_data_orders").insert(row).select(BUNDLE_ROW).single()
        if (error) throw error // 23505 => the service looks the winner up by (shop, key)
        return data as StorefrontBundleRow
      },
      caps: capDeps(request, db),
    },
  }
}

export function getAvailabilityRuntime(): { deps: AvailabilityDeps; db: SupabaseClient } {
  const { deps, db } = getBundlesRuntime()
  return {
    db,
    deps: {
      getCashbackConfig: deps.getCashbackConfig,
      getHubtelConfig: deps.getHubtelConfig,
      getBillsAvailability: () => getBillsAvailability(db),
      getBundlesAvailability: () => getBundlesAvailability(db, deps.getHubtelConfig),
    },
  }
}

/**
 * Bot defences shared by the public storefront endpoints, mirroring storefront airtime: honeypot, Turnstile (admin
 * kill switch), the optional __shop_sess cookie binding and, on initialize, the optional payer-phone OTP gate.
 * Returns a { status, error, code? } to send, or null to continue.
 */
export async function storefrontGuards(
  request: NextRequest,
  db: SupabaseClient,
  shopId: string,
  body: Record<string, unknown>,
  opts: { tag: string; otpPhone?: unknown; requireTurnstile?: boolean },
): Promise<{ status: number; error: string; code?: string } | null> {
  const honeypot = body.website
  if (typeof honeypot === "string" && honeypot.trim() !== "") {
    console.warn(`[${opts.tag}] Honeypot tripped for shop ${shopId}`)
    return { status: 400, error: "Invalid request" }
  }

  const turnstileOn = await isTurnstileEnabled()
  if (opts.requireTurnstile && (!turnstileOn || !process.env.TURNSTILE_SECRET_KEY)) {
    // Endpoints that reveal account data never run without the human check.
    console.warn(`[${opts.tag}] Turnstile disabled or not configured — failing closed for shop ${shopId}`)
    return { status: 503, error: "Verification unavailable" }
  }
  if (!turnstileOn) {
    console.warn(`[${opts.tag}] Turnstile DISABLED by admin toggle — skipping verification for shop ${shopId}`)
  } else {
    const t = await verifyTurnstileToken(typeof body.turnstileToken === "string" ? body.turnstileToken : undefined, getRequestIp(request.headers))
    if (!t.valid) {
      console.warn(`[${opts.tag}] Turnstile failed (${t.reason}) for shop ${shopId}`)
      return { status: 403, error: "Verification failed. Please refresh the page and try again." }
    }
  }

  if (process.env.SHOP_SESSION_ENFORCED === "true") {
    const cookie = request.cookies.get("__shop_sess")?.value
    const { data: shop } = await db.from("user_shops").select("shop_slug").eq("id", shopId).maybeSingle()
    const slug = (shop as { shop_slug?: string } | null)?.shop_slug
    if (!cookie || !slug || !verifyShopSession(cookie, slug).valid) {
      console.warn(`[${opts.tag}] Invalid or missing __shop_sess cookie for shop ${shopId}`)
      return { status: 403, error: "Invalid session. Please refresh the page and try again." }
    }
  }

  if (opts.otpPhone !== undefined && (await isStorefrontOtpRequired())) {
    const phone = typeof opts.otpPhone === "string" ? opts.otpPhone.trim() : ""
    if (!phone || !(await isPhoneOtpVerified(phone))) {
      return { status: 403, error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" }
    }
  }
  return null
}
