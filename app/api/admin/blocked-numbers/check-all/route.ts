// Admin "Check all providers": asks every configured whitelist provider about the selected blocked numbers.
// Only rows a CHECKOUT provider allows are flipped (through the normal recheck path); anything else is info.
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { recheckBlockedNumbers } from "@/lib/blocked-numbers/recheck"
import { checkAllProviders } from "@/lib/blocked-numbers/all-providers"
import { isUuid } from "@/lib/blocked-numbers/admin-view"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const MAX_IDS = 100

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null
  const ids = body && typeof body === "object" ? body.ids : null
  if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ error: "Provide ids" }, { status: 400 })
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `At most ${MAX_IDS} ids per request` }, { status: 400 })
  if (!ids.every(isUuid)) return NextResponse.json({ error: "ids must be uuids" }, { status: 400 })
  const uniqueIds = [...new Set(ids as string[])]

  try {
    const { data, error } = await supabaseAdmin.from("mtn_blocked_numbers").select("id, phone").in("id", uniqueIds)
    if (error) throw error
    const found = (data ?? []) as Array<{ id: string; phone: string }>
    if (found.length === 0) return NextResponse.json({ error: "No matching numbers" }, { status: 404 })

    const { providers, checkoutProviders, rows } = await checkAllProviders(found.map((r) => r.phone))

    const outRows = found.map((r, i) => ({
      id: r.id,
      phone: r.phone,
      results: rows[i].results,
      allowedByCheckout: rows[i].allowedByCheckout,
      allowedOutsideCheckout: rows[i].allowedOutsideCheckout,
    }))

    const flipIds = outRows.filter((r) => r.allowedByCheckout).map((r) => r.id)
    let flipped = 0
    if (flipIds.length > 0) {
      const res = await recheckBlockedNumbers({ ids: flipIds, reopenExpired: true })
      flipped = res.allowed
    }
    console.log(`[BLOCKED-ADMIN] check-all rows=${outRows.length} checkoutAllowed=${flipIds.length} flipped=${flipped}`)
    return NextResponse.json({ success: true, providers, checkoutProviders, rows: outRows, flipped })
  } catch (err) {
    console.error("[BLOCKED-ADMIN] check-all failed:", err instanceof Error ? err.name : "UnknownError")
    return NextResponse.json({ error: "Check failed" }, { status: 500 })
  }
}
