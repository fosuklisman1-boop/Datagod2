import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", key)
    .single()
  return data?.value ?? null
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const slug = searchParams.get("slug")
    const network = searchParams.get("network")

    if (!slug || !network) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }

    // 1. Fetch Shop and Merchant details
    const { data: shop } = await supabase
      .from("user_shops")
      .select("id, user_id, airtime_markup_mtn, airtime_markup_telecel, airtime_markup_at")
      .eq("shop_slug", slug)
      .single()

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // 2. Get Merchant Role to determine their base fee
    const { data: merchantProfile } = await supabase
      .from("users")
      .select("role")
      .eq("id", shop.user_id)
      .single()
    
    const isDealer = merchantProfile?.role === "dealer"
    const networkKey = network.toLowerCase()
    const feeKey = `airtime_fee_${networkKey}_${isDealer ? 'dealer' : 'customer'}`
    
    // 3. Fetch Base Fee Rate
    const feeSetting = await getAdminSetting(feeKey)
    const baseFeePercent = feeSetting?.rate ?? 5

    // 4. Get Actual Markup
    let markupPercent = parseFloat(shop[`airtime_markup_${networkKey}` as keyof typeof shop] as string) || 0

    // ENFORCE PLATFORM SAFETY CAP (10% total)
    if (baseFeePercent + markupPercent > 10) {
      markupPercent = Math.max(0, 10 - baseFeePercent)
    }

    // 5. Check Network Availability
    const availabilitySetting = await getAdminSetting(`airtime_enabled_${networkKey}`)
    const isAvailable = availabilitySetting?.enabled !== false

    return NextResponse.json({
      success: true,
      baseFeePercent,
      markupPercent,
      totalFeePercent: baseFeePercent + markupPercent,
      isAvailable
    })

  } catch (error) {
    console.error("[PUBLIC-AIRTIME-CONSTRAINTS] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
