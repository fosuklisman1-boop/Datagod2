import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getMTNProvider } from "@/lib/mtn-providers/factory"
import { SykesProvider } from "@/lib/mtn-providers/sykes-provider"
import { DataKazinaProvider } from "@/lib/mtn-providers/datakazina-provider"

/**
 * GET /api/admin/fulfillment/mtn-balance
 * Check MTN wallet balance from BOTH providers (admin only)
 */
export async function GET(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    // Fetch balances from BOTH providers in parallel
    const sykesProvider = new SykesProvider()
    const datakazinaProvider = new DataKazinaProvider()

    const [sykesBalance, datakazinaBalance] = await Promise.all([
      sykesProvider.checkBalance().catch(() => null),
      datakazinaProvider.checkBalance().catch(() => null)
    ])

    // Get the currently selected provider
    const activeProvider = await getMTNProvider()

    // Get alert threshold
    const { data: settingData } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "mtn_balance_alert_threshold")
      .single()

    const threshold = parseInt(settingData?.value || "500", 10)

    // Check if either balance is low
    const sykesLow = sykesBalance !== null && sykesBalance < threshold
    const datakazinaLow = datakazinaBalance !== null && datakazinaBalance < threshold

    // Send SMS alert if balance is low
    if (sykesLow || datakazinaLow) {
      await sendLowBalanceAlert(sykesBalance, datakazinaBalance, threshold, sykesLow, datakazinaLow)
    }

    return NextResponse.json({
      success: true,
      balances: {
        sykes: {
          balance: sykesBalance,
          currency: "GHS",
          is_low: sykesLow,
          is_active: activeProvider.name === "sykes",
          alert: sykesLow && sykesBalance !== null ? `Sykes balance is below threshold of ₵${threshold}` : null,
        },
        datakazina: {
          balance: datakazinaBalance,
          currency: "GHS",
          is_low: datakazinaLow,
          is_active: activeProvider.name === "datakazina",
          alert: datakazinaLow && datakazinaBalance !== null ? `DataKazina balance is below threshold of ₵${threshold}` : null,
        }
      },
      threshold,
      active_provider: activeProvider.name,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[MTN Balance] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * Send SMS alert when balance is low
 */
async function sendLowBalanceAlert(
  sykesBalance: number | null,
  datakazinaBalance: number | null,
  threshold: number,
  sykesLow: boolean,
  datakazinaLow: boolean
) {
  try {
    // Get admin phone number from settings
    const { data: adminPhone } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "admin_alert_phone")
      .single()

    if (!adminPhone?.value?.phone) {
      console.warn("[Balance Alert] No admin phone configured")
      return
    }

    // Check if we already sent an alert recently (avoid spam)
    const { data: recentAlert } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "last_balance_alert")
      .single()

    const lastAlertTime = recentAlert?.value?.timestamp ? new Date(recentAlert.value.timestamp) : null
    const now = new Date()

    // Only send alert once per hour
    if (lastAlertTime && (now.getTime() - lastAlertTime.getTime()) < 3600000) {
      console.log("[Balance Alert] Alert sent recently, skipping")
      return
    }

    // Build alert message
    let message = "⚠️ MTN WALLET ALERT\n\n"

    if (sykesLow && sykesBalance !== null) {
      message += `Sykes: ₵${sykesBalance.toFixed(2)} (LOW)\n`
    }
    if (datakazinaLow && datakazinaBalance !== null) {
      message += `DataKazina: ₵${datakazinaBalance.toFixed(2)} (LOW)\n`
    }

    message += `\nThreshold: ₵${threshold}\nPlease top up your MTN account(s).`

    // Send SMS via Termii (adjust to your SMS provider)
    const TERMII_API_KEY = process.env.TERMII_API_KEY
    const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || "DataGod"

    if (!TERMII_API_KEY) {
      console.warn("[Balance Alert] No Termii API key configured")
      return
    }

    await fetch("https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: adminPhone.value.phone,
        from: TERMII_SENDER_ID,
        sms: message,
        type: "plain",
        channel: "generic",
        api_key: TERMII_API_KEY,
      }),
    })

    // Update last alert timestamp
    await supabase
      .from("admin_settings")
      .upsert({
        key: "last_balance_alert",
        value: { timestamp: now.toISOString() }
      })

    console.log("[Balance Alert] SMS sent successfully")
  } catch (error) {
    console.error("[Balance Alert] Failed to send SMS:", error)
  }
}
