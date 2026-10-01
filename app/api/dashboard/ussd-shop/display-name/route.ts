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

  // An empty/whitespace-only name clears the override (reverting to
  // shop_name) rather than being rejected — otherwise, once set, it could
  // never be unset. validateUssdDisplayName still rejects empty for its own
  // callers (the "required" message serves the plain single-field-validation
  // case); this route special-cases it into "clear" instead.
  const trimmed = String(name ?? "").trim()
  const toSave: string | null = trimmed === "" ? null : trimmed

  if (toSave !== null) {
    const validation = validateUssdDisplayName(toSave)
    if (!validation.valid) {
      return NextResponse.json({ error: validation.reason }, { status: 400 })
    }
  }

  const { data: shop } = await supabase
    .from("user_shops").select("id").eq("user_id", user.id).single()
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { error: updateError } = await supabase
    .from("user_shops")
    .update({ ussd_display_name: toSave })
    .eq("id", shop.id)

  if (updateError) {
    console.error("[USSD-DISPLAY-NAME] update failed:", updateError)
    return NextResponse.json({ error: "Failed to save display name" }, { status: 500 })
  }

  return NextResponse.json({ success: true, ussd_display_name: toSave })
}
