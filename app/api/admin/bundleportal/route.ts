import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { BundlePortalProvider, MTN_ROUTE_KEY } from "@/lib/mtn-providers/bundleportal-provider"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const action = request.nextUrl.searchParams.get("action")

  try {
    const provider = new BundlePortalProvider()
    if (action === "balance") {
      const balance = await provider.checkBalance()
      return NextResponse.json({ success: true, balance, currency: "GHS" })
    }
    if (action === "mtn-route") {
      const { data } = await supabase
        .from("admin_settings")
        .select("value")
        .eq("key", MTN_ROUTE_KEY)
        .maybeSingle()
      const route = data?.value?.route
      return NextResponse.json({ success: true, route: route === "mtn_2" || route === "mtn_3" ? route : "mtn" })
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-BUNDLEPORTAL] GET error:", error)
    return NextResponse.json({ error: "Bundle Portal request failed" }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const provider = new BundlePortalProvider()

    if (body.action === "verify") {
      if (typeof body.phone !== "string" || !body.phone) {
        return NextResponse.json({ error: "phone is required" }, { status: 400 })
      }
      const result = await provider.verifyNumber(body.phone, body.network ?? "mtn")
      return NextResponse.json(result)
    }

    if (body.action === "set-mtn-route") {
      const route = body.route
      if (route !== "mtn" && route !== "mtn_2" && route !== "mtn_3") {
        return NextResponse.json({ error: "Invalid route. Use: mtn, mtn_2, mtn_3" }, { status: 400 })
      }
      const { error } = await supabase
        .from("admin_settings")
        .upsert({ key: MTN_ROUTE_KEY, value: { route }, updated_at: new Date().toISOString() }, { onConflict: "key" })
      if (error) {
        console.error("[ADMIN-BUNDLEPORTAL] Failed to save MTN route:", error)
        return NextResponse.json({ error: "Failed to save setting" }, { status: 500 })
      }
      return NextResponse.json({ success: true, route })
    }

    if (body.action === "register-webhook") {
      if (typeof body.webhookUrl !== "string" || !body.webhookUrl) {
        return NextResponse.json({ error: "webhookUrl is required" }, { status: 400 })
      }
      const result = await provider.setWebhook(body.webhookUrl)
      // The webhook_secret in this response is shown ONLY here, once — this
      // route never stores it. The admin must copy it into
      // BUNDLEPORTAL_WEBHOOK_SECRET in Vercel themselves.
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-BUNDLEPORTAL] POST error:", error)
    return NextResponse.json({ error: "Bundle Portal request failed" }, { status: 502 })
  }
}
