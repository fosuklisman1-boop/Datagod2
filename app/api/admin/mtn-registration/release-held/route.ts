import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/mtn-registration/release-held
 * On-demand version of the hourly release-held-mtn-orders cron: re-checks
 * every held_registration order's number against the registry (and, for
 * whatever's still held after that, against whitelist_status) and releases
 * anything that's actually confirmed registered/allowed right now. Never
 * force-releases a number that isn't confirmed — same safety guarantees as
 * the cron, just triggered immediately instead of waiting up to an hour.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { releaseHeldMtnOrders, releaseWhitelistHeldOrders, getHeldOrderPhones } = await import("@/lib/mtn-hold")

    // Pass 1: registration-gate sweep (mtn_number_registry.status = 'registered').
    const registryPass = await releaseHeldMtnOrders()

    // Pass 2: whatever's still held might be held for a whitelist reason whose
    // number has since cleared — registration status and whitelist status are
    // independent columns on the same registry row, so a number can already be
    // 'registered' (pass 1 wouldn't touch it further) while also having been
    // whitelist-blocked, or vice versa. Find still-held phones now allowed and
    // release those specifically.
    // Best-effort — a failure here is caught by the hourly self-heal cron.
    let whitelistPass = { released: 0, dispatched: 0, failed: 0 }
    try {
      const stillHeldPhones = await getHeldOrderPhones()
      if (stillHeldPhones.length > 0) {
        const { data: allowedRows, error: allowedErr } = await supabase
          .from("mtn_number_registry")
          .select("phone")
          .in("phone", stillHeldPhones)
          .eq("whitelist_status", "allowed")
        if (allowedErr) {
          console.error("[RELEASE-HELD] allowed-phones query failed:", allowedErr)
        } else {
          const allowedPhones = (allowedRows ?? []).map((r: any) => r.phone).filter(Boolean)
          if (allowedPhones.length > 0) {
            whitelistPass = await releaseWhitelistHeldOrders(allowedPhones)
          }
        }
      }
    } catch (wlErr) {
      console.error("[RELEASE-HELD] whitelist pass failed (cron will catch):", wlErr)
    }

    return NextResponse.json({
      ok: true,
      checked: registryPass.checked,
      released: registryPass.released + whitelistPass.released,
      dispatched: registryPass.dispatched + whitelistPass.dispatched,
      queuedManual: registryPass.queuedManual,
      failed: registryPass.failed + whitelistPass.failed,
    })
  } catch (error) {
    console.error("[RELEASE-HELD] error:", error)
    return NextResponse.json({ error: "Failed to release held orders" }, { status: 500 })
  }
}
