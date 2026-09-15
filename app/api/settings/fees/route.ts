import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  try {
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("paystack_fee_percentage, wallet_topup_fee_percentage, withdrawal_fee_percentage, withdrawal_fee_minimum, minimum_withdrawal_amount")
      .is("key", null)
      .single()

    if (error && error.code !== "PGRST116") {
      console.error("[FEES-API] Error fetching settings:", error)
      // Return default fees if error
      return NextResponse.json({
        paystack_fee_percentage: 3.0,
        wallet_topup_fee_percentage: 0,
        withdrawal_fee_percentage: 0,
        withdrawal_fee_minimum: 0,
        minimum_withdrawal_amount: 5,
      })
    }

    // If no settings exist, return defaults
    if (!settings) {
      return NextResponse.json({
        paystack_fee_percentage: 3.0,
        wallet_topup_fee_percentage: 0,
        withdrawal_fee_percentage: 0,
        withdrawal_fee_minimum: 0,
        minimum_withdrawal_amount: 5,
      })
    }

    return NextResponse.json({
      paystack_fee_percentage: settings.paystack_fee_percentage || 3.0,
      wallet_topup_fee_percentage: settings.wallet_topup_fee_percentage || 0,
      withdrawal_fee_percentage: settings.withdrawal_fee_percentage || 0,
      withdrawal_fee_minimum: settings.withdrawal_fee_minimum ?? 0,
      minimum_withdrawal_amount: settings.minimum_withdrawal_amount ?? 5,
    })
  } catch (error) {
    console.error("[FEES-API] Error:", error)
    return NextResponse.json(
      {
        paystack_fee_percentage: 3.0,
        wallet_topup_fee_percentage: 0,
        withdrawal_fee_percentage: 0,
        withdrawal_fee_minimum: 0,
        minimum_withdrawal_amount: 5,
      },
      { status: 500 }
    )
  }
}
