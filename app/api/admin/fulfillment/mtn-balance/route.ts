import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getMTNProvider } from "@/lib/mtn-providers/factory"
import { SykesProvider } from "@/lib/mtn-providers/sykes-provider"
import { DataKazinaProvider } from "@/lib/mtn-providers/datakazina-provider"
import { XpressProvider } from "@/lib/mtn-providers/xpress-provider"
import { EazyGhDataProvider } from "@/lib/mtn-providers/eazyghdata-provider"
import { BisdelProvider } from "@/lib/mtn-providers/bisdel-provider"
import { CodeCraftMTNProvider } from "@/lib/mtn-providers/codecraft-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"

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

    // Fetch balances from all providers in parallel
    const sykesProvider = new SykesProvider()
    const datakazinaProvider = new DataKazinaProvider()
    const xpressProvider = new XpressProvider()
    const eazyghDataProvider = new EazyGhDataProvider()
    const bisdelProvider = new BisdelProvider()
    const codeCraftProvider = new CodeCraftMTNProvider()

    const [sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance, bisdelBalance, codeCraftBalance] = await Promise.all([
      sykesProvider.checkBalance().catch(() => null),
      datakazinaProvider.checkBalance().catch(() => null),
      xpressProvider.checkBalance().catch(() => null),
      eazyghDataProvider.checkBalance().catch(() => null),
      bisdelProvider.checkBalance().catch(() => null),
      codeCraftProvider.checkBalance().catch(() => null),
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

    // Check if any balance is low
    const sykesLow = sykesBalance !== null && sykesBalance < threshold
    const datakazinaLow = datakazinaBalance !== null && datakazinaBalance < threshold
    const xpressLow = xpressBalance !== null && xpressBalance < threshold
    const eazyghDataLow = eazyghDataBalance !== null && eazyghDataBalance < threshold
    const bisdelLow = bisdelBalance !== null && bisdelBalance < threshold
    const codeCraftLow = codeCraftBalance !== null && codeCraftBalance < threshold

    const balanceMap = { sykes: sykesBalance, datakazina: datakazinaBalance, xpress: xpressBalance, eazyghdata: eazyghDataBalance, bisdel: bisdelBalance, codecraft: codeCraftBalance }
    const lowMap = { sykes: sykesLow, datakazina: datakazinaLow, xpress: xpressLow, eazyghdata: eazyghDataLow, bisdel: bisdelLow, codecraft: codeCraftLow }

    if (sykesLow || datakazinaLow || xpressLow || eazyghDataLow || bisdelLow || codeCraftLow) {
      sendLowBalanceAlert(balanceMap, lowMap, threshold).catch((e) => console.error("[MTN Balance] Alert error:", e))
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
        },
        xpress: {
          balance: xpressBalance,
          currency: "GHS",
          is_low: xpressLow,
          is_active: activeProvider.name === "xpress",
          alert: xpressLow && xpressBalance !== null ? `Xpress balance is below threshold of ₵${threshold}` : null,
        },
        eazyghdata: {
          balance: eazyghDataBalance,
          currency: "GHS",
          is_low: eazyghDataLow,
          is_active: activeProvider.name === "eazyghdata",
          alert: eazyghDataLow && eazyghDataBalance !== null ? `EazyGhData balance is below threshold of ₵${threshold}` : null,
        },
        bisdel: {
          balance: bisdelBalance,
          currency: "GHS",
          is_low: bisdelLow,
          is_active: activeProvider.name === "bisdel",
          alert: bisdelLow && bisdelBalance !== null ? `Bisdel balance is below threshold of ₵${threshold}` : null,
        },
        codecraft: {
          balance: codeCraftBalance,
          currency: "GHS",
          is_low: codeCraftLow,
          is_active: activeProvider.name === "codecraft",
          alert: codeCraftLow && codeCraftBalance !== null ? `CodeCraft balance is below threshold of ₵${threshold}` : null,
        },
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

