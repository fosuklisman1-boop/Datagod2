import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { authUserId } from "@/lib/blocked-numbers/user-auth"
import { buildOwnerView, loadOwnerRaw } from "@/lib/text-to-buy/owner-view"

export const dynamic = "force-dynamic"

/**
 * The signed-in shop owner's Text-to-Buy shop-line summary. Read-only. The shop is derived from the session user; no id is
 * ever taken from the request. Customer sender numbers are never selected and recipients are masked (see owner-view.ts).
 */
export async function GET(request: NextRequest) {
  const userId = await authUserId(request)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const raw = await loadOwnerRaw(supabaseAdmin, userId)
    if (!raw) return NextResponse.json({ hasShop: false })
    return NextResponse.json({ hasShop: true, ...buildOwnerView(raw) })
  } catch {
    return NextResponse.json({ error: "Failed to load text orders" }, { status: 500 })
  }
}
