import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { authenticate } from "@/lib/bills/route-auth"
import { getBuyerTier } from "@/lib/bills/runtime"
import { getCashbackConfig } from "@/lib/cashback/config"
import { buildCashbackRates, NO_CASHBACK_RATES } from "@/lib/cashback/rates"
import { getAirtimeProvider } from "@/lib/airtime-provider"
import { isDigiWapyConfigured, isDigiWapyEnabledForNetwork } from "@/lib/digiwapy-provider"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const rl = await applyRateLimit(request, "cashback_rates", 60, 60_000, auth.userId)
    if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })

    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const cfg = await getCashbackConfig(db)
    if (!cfg.enabled || !cfg.surfaces.dashboard) return NextResponse.json(NO_CASHBACK_RATES)
    const buyer = await getBuyerTier(db, auth.userId)
    const rates = await buildCashbackRates(
      cfg, buyer,
      network => getAirtimeProvider(db, network, isDigiWapyEnabledForNetwork),
      isDigiWapyConfigured(),
    )
    return NextResponse.json(rates)
  } catch (e) {
    console.warn("[cashback] rates unavailable:", e instanceof Error ? e.message : "error")
    return NextResponse.json(NO_CASHBACK_RATES)
  }
}
