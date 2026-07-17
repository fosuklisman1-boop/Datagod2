import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { SykesProvider } from "@/lib/mtn-providers/sykes-provider"
import { DataKazinaProvider } from "@/lib/mtn-providers/datakazina-provider"
import { XpressProvider } from "@/lib/mtn-providers/xpress-provider"
import { EazyGhDataProvider } from "@/lib/mtn-providers/eazyghdata-provider"
import { BisdelProvider } from "@/lib/mtn-providers/bisdel-provider"
import { CodeCraftMTNProvider } from "@/lib/mtn-providers/codecraft-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!

  try {
    const [sykes, datakazina, xpress, eazyghdata, bisdel, codecraft] = await Promise.all([
      new SykesProvider().checkBalance().catch(() => null),
      new DataKazinaProvider().checkBalance().catch(() => null),
      new XpressProvider().checkBalance().catch(() => null),
      new EazyGhDataProvider().checkBalance().catch(() => null),
      new BisdelProvider().checkBalance().catch(() => null),
      new CodeCraftMTNProvider().checkBalance().catch(() => null),
    ])

    const { data: settingData } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "mtn_balance_alert_threshold")
      .maybeSingle()

    const threshold = parseInt(settingData?.value || "500", 10)

    const balances = { sykes, datakazina, xpress, eazyghdata, bisdel, codecraft }
    const lows = {
      sykes: sykes !== null && sykes < threshold,
      datakazina: datakazina !== null && datakazina < threshold,
      xpress: xpress !== null && xpress < threshold,
      eazyghdata: eazyghdata !== null && eazyghdata < threshold,
      bisdel: bisdel !== null && bisdel < threshold,
      codecraft: codecraft !== null && codecraft < threshold,
    }

    const anyLow = Object.values(lows).some(Boolean)

    if (anyLow) {
      await sendLowBalanceAlert(balances, lows, threshold)
    }

    console.log(`[CRON-MTN-BALANCE] threshold=₵${threshold} anyLow=${anyLow}`, balances)
    return NextResponse.json({ success: true, threshold, anyLow, balances })
  } catch (error: any) {
    console.error("[CRON-MTN-BALANCE] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
