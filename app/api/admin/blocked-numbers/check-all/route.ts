// Admin "Check all providers": asks every configured whitelist provider about the selected blocked numbers.
// Only rows a CHECKOUT provider allows are flipped (through the normal recheck path); anything else is info.
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { recheckBlockedNumbers } from "@/lib/blocked-numbers/recheck"
import { markAllowedByAdminCheck } from "@/lib/blocked-numbers/admin-allow"
import { checkAllProviders } from "@/lib/blocked-numbers/all-providers"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { isUuid } from "@/lib/blocked-numbers/admin-view"

export const dynamic = "force-dynamic"
export const maxDuration = 300

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

    // Ask each distinct (normalised) number once; map the answer back to every row carrying it.
    const keyOf = (phone: string) => normalizeGhanaPhone(phone) ?? phone
    const distinct = new Map<string, string>()
    for (const r of found) if (!distinct.has(keyOf(r.phone))) distinct.set(keyOf(r.phone), r.phone)
    const { providers, checkoutProviders, failedProviders, rows } = await checkAllProviders([...distinct.values()])
    const byKey = new Map(rows.map((r) => [keyOf(r.phone), r]))

    const outRows = found.map((r) => {
      const a = byKey.get(keyOf(r.phone))!
      return {
        id: r.id,
        phone: r.phone,
        results: a.results,
        allowedByCheckout: a.allowedByCheckout,
        allowedOutsideCheckout: a.allowedOutsideCheckout,
      }
    })

    const flipIds = outRows.filter((r) => r.allowedByCheckout).map((r) => r.id)
    let flipped = 0
    let recheckFailed = false
    if (flipIds.length > 0) {
      try {
        const res = await recheckBlockedNumbers({ ids: flipIds, reopenExpired: true })
        flipped = res.allowed
      } catch (err) {
        recheckFailed = true
        console.error("[BLOCKED-ADMIN] check-all recheck failed:", err instanceof Error ? err.name : "UnknownError")
      }
    }

    // Owner decision 2026-11-21: any configured provider's approval lets the number through checkout.
    // Rows no checkout provider allowed are flipped directly (guarded) and their verified verdict cached.
    const outsideRows = outRows
      .filter((r) => !r.allowedByCheckout && r.allowedOutsideCheckout.length > 0)
      .map((r) => ({ id: r.id, phone: r.phone, allowedBy: r.allowedOutsideCheckout[0] }))
    let flippedOutside = 0
    let flippedOutsideIds: string[] = []
    let flipFailed = false
    if (outsideRows.length > 0) {
      try {
        const res = await markAllowedByAdminCheck(outsideRows)
        flippedOutsideIds = res.updatedIds
        flippedOutside = res.updatedIds.length
        flipFailed = res.failed
      } catch (err) {
        flipFailed = true
        console.error("[BLOCKED-ADMIN] check-all direct flip failed:", err instanceof Error ? err.name : "UnknownError")
      }
    }
    console.log(`[BLOCKED-ADMIN] check-all rows=${outRows.length} checkoutAllowed=${flipIds.length} flipped=${flipped} flippedOutside=${flippedOutside} recheckFailed=${recheckFailed} flipFailed=${flipFailed}`)
    return NextResponse.json({
      success: true,
      providers,
      checkoutProviders,
      failedProviders: failedProviders ?? [],
      rows: outRows,
      flipped: flipped + flippedOutside,
      flippedOutside,
      flippedOutsideIds,
      ...(recheckFailed ? { recheckFailed: true } : {}),
      ...(flipFailed ? { flipFailed: true } : {}),
    })
  } catch (err) {
    console.error("[BLOCKED-ADMIN] check-all failed:", err instanceof Error ? err.name : "UnknownError")
    return NextResponse.json({ error: "Check failed" }, { status: 500 })
  }
}
