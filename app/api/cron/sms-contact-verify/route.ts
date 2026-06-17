import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { processGlobalContactVerifyChunk } from "@/lib/sms/contact-verify-service"

// Moolre name lookups are slow (~12–25s each); allow several chunks per tick.
export const maxDuration = 300

/**
 * Backstop drain for tenant contact verification: processes 'pending' contacts
 * across all tenant groups so a verify job survives the tenant closing their
 * tab mid-run. The client poll handles the live case; this catches stragglers.
 * Auth via CRON_SECRET or admin Bearer token (verifyAdminAccess).
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    let processed = 0
    let verified = 0
    let invalid = 0
    let rateLimited = 0
    // Up to 8 chunks; stop early if a chunk makes NO definitive progress (all
    // rate-limited) to avoid spinning on a throttled provider.
    for (let i = 0; i < 8; i++) {
      const c = await processGlobalContactVerifyChunk()
      processed += c.processed
      verified += c.verified
      invalid += c.invalid
      rateLimited += c.rateLimited
      if (c.processed === 0) break
      // Yield when the provider is clearly throttling — half-or-more of the chunk
      // came back rate-limited — instead of hammering it for the remaining chunks
      // just because one unrelated row happened to resolve.
      if (c.rateLimited / c.processed >= 0.5) break
    }
    return NextResponse.json({ success: true, data: { processed, verified, invalid, rateLimited } })
  } catch (e: unknown) {
    console.error("[CRON-SMS-CONTACT-VERIFY] Error:", e)
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : "Internal error" }, { status: 500 })
  }
}
