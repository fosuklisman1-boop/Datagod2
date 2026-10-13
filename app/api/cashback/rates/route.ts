import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { authenticate } from "@/lib/bills/route-auth"
import { getBuyerTier } from "@/lib/bills/runtime"
import { getCashbackConfig, groupOf, effectiveShares } from "@/lib/cashback/config"
import { quoteCashback } from "@/lib/cashback/quote"
import { getAirtimeProvider } from "@/lib/airtime-provider"
import { isDigiWapyEnabledForNetwork } from "@/lib/digiwapy-provider"
import { HUBTEL_CS_SERVICES } from "@/lib/hubtel-cs/services"

export const dynamic = "force-dynamic"

const NONE = { applied: false, services: {} }
const AIRTIME_NETWORK: Record<string, string> = { airtime_mtn: "MTN", airtime_telecel: "Telecel", airtime_at: "AT" }

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
    if (!cfg.enabled || !cfg.surfaces.dashboard) return NextResponse.json(NONE)
    const buyer = await getBuyerTier(db, auth.userId)

    const services: Record<string, { provider: string; rate: number; share: number; maxFace?: number }> = {}
    const airtimeProviders: Record<string, string> = {}
    for (const rateKey of Object.keys(cfg.rates)) {
      const [serviceKey, ratedProvider] = rateKey.split(":")
      if (!serviceKey || !ratedProvider || groupOf(serviceKey) === null) continue
      let provider = ratedProvider
      const network = AIRTIME_NETWORK[serviceKey]
      if (network) {
        airtimeProviders[serviceKey] ??= await getAirtimeProvider(db, network, isDigiWapyEnabledForNetwork)
        provider = airtimeProviders[serviceKey]
      } else if (ratedProvider !== "hubtel") {
        continue // bundles and bills are always fulfilled through Hubtel
      }
      if (provider !== ratedProvider || provider === "manual") continue
      const q = quoteCashback({ serviceKey, provider: provider as "hubtel" | "digiwapy", faceAmount: 100, buyer, channel: "dashboard" }, cfg)
      if (!q.applied) continue
      const entry: { provider: string; rate: number; share: number; maxFace?: number } = {
        provider, rate: q.rate, share: effectiveShares(cfg, serviceKey)[buyer],
      }
      if (network && provider === "hubtel") {
        const max = (HUBTEL_CS_SERVICES as Record<string, { maxAmount?: number }>)[serviceKey]?.maxAmount
        if (max !== undefined) entry.maxFace = max
      }
      services[serviceKey] = entry
    }
    return NextResponse.json({ applied: Object.keys(services).length > 0, services })
  } catch (e) {
    console.warn("[cashback] rates unavailable:", e instanceof Error ? e.message : "error")
    return NextResponse.json(NONE)
  }
}
