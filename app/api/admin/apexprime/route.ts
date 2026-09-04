import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { ApexPrimeProvider, FULFILLMENT_PATH_KEYS } from "@/lib/mtn-providers/apexprime-provider"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const action = request.nextUrl.searchParams.get("action")

  try {
    const provider = new ApexPrimeProvider()
    if (action === "balance") {
      return NextResponse.json(await provider.getWalletSummary())
    }
    if (action === "transactions") {
      return NextResponse.json(await provider.getTransactions())
    }
    if (action === "fulfillment-paths") {
      const networks = ["MTN", "Telecel", "AirtelTigo"] as const
      const paths: Record<string, string> = {}
      for (const network of networks) {
        const { data } = await supabase
          .from("admin_settings")
          .select("value")
          .eq("key", FULFILLMENT_PATH_KEYS[network])
          .maybeSingle()
        paths[network] = data?.value?.path === "store" ? "store" : "groupshare"
      }
      return NextResponse.json({ success: true, paths })
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-APEXPRIME] GET error:", error)
    return NextResponse.json({ error: "Apex Prime request failed" }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const provider = new ApexPrimeProvider()

    if (body.action === "verify") {
      if (typeof body.phone !== "string" || !body.phone) {
        return NextResponse.json({ error: "phone is required" }, { status: 400 })
      }
      const result = await provider.verifyNumber(body.phone, body.network ?? "MTN")
      return NextResponse.json(result)
    }

    if (body.action === "set-fulfillment-path") {
      const network = body.network as "MTN" | "Telecel" | "AirtelTigo"
      const path = body.path
      if (!FULFILLMENT_PATH_KEYS[network]) {
        return NextResponse.json({ error: "Invalid network. Use: MTN, Telecel, AirtelTigo" }, { status: 400 })
      }
      if (path !== "groupshare" && path !== "store") {
        return NextResponse.json({ error: "Invalid path. Use: groupshare, store" }, { status: 400 })
      }
      const { error } = await supabase
        .from("admin_settings")
        .upsert({ key: FULFILLMENT_PATH_KEYS[network], value: { path }, updated_at: new Date().toISOString() }, { onConflict: "key" })
      if (error) {
        console.error("[ADMIN-APEXPRIME] Failed to save fulfillment path:", error)
        return NextResponse.json({ error: "Failed to save setting" }, { status: 500 })
      }
      return NextResponse.json({ success: true, network, path })
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-APEXPRIME] POST error:", error)
    return NextResponse.json({ error: "Apex Prime request failed" }, { status: 502 })
  }
}
