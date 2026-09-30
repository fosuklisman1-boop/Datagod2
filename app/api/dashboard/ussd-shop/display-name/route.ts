import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { validateUssdDisplayName } from "@/lib/ussd-display-name"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/display-name
// Body: { name: string }
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { name } = await request.json()

  const validation = validateUssdDisplayName(String(name ?? ""))
  if (!validation.valid) {
    return NextResponse.json({ error: validation.reason }, { status: 400 })
  }
  const trimmed = String(name).trim()

  const { data: shop } = await supabase
    .from("user_shops").select("id").eq("user_id", user.id).single()
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { error: updateError } = await supabase
    .from("user_shops")
    .update({ ussd_display_name: trimmed })
    .eq("id", shop.id)

  if (updateError) {
    console.error("[USSD-DISPLAY-NAME] update failed:", updateError)
    return NextResponse.json({ error: "Failed to save display name" }, { status: 500 })
  }

  return NextResponse.json({ success: true, ussd_display_name: trimmed })
}
