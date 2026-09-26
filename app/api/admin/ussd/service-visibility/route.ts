import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  getUssdServiceVisibility,
  setUssdServiceVisibility,
  type UssdServiceVisibility,
} from "@/lib/ussd-service-visibility"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const VALID_SERVICES: (keyof UssdServiceVisibility)[] = ["data", "afa", "airtime", "resultsChecker"]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const status = await getUssdServiceVisibility(adminClient)
    return NextResponse.json({ status })
  } catch (error) {
    console.error("[USSD-SERVICE-VISIBILITY] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch USSD service visibility" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { service, visible } = body ?? {}

  if (!VALID_SERVICES.includes(service)) {
    return NextResponse.json(
      { error: `service must be one of: ${VALID_SERVICES.join(", ")}` },
      { status: 400 }
    )
  }

  if (typeof visible !== "boolean") {
    return NextResponse.json({ error: "visible must be a boolean" }, { status: 400 })
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const status = await setUssdServiceVisibility(adminClient, service as keyof UssdServiceVisibility, visible)

    // Best-effort audit trail — never blocks the response on failure (same
    // fire-and-forget pattern as network-stock's admin_audit_log insert).
    adminClient
      .from("admin_audit_log")
      .insert([
        {
          admin_id: userId,
          action: "ussd_service_visibility_toggle",
          target_user_id: null,
          old_value: { service },
          new_value: { visible },
          created_at: new Date().toISOString(),
        },
      ])
      .then(({ error }: { error: any }) => {
        if (error) console.warn("[ADMIN-AUDIT] ussd_service_visibility_toggle log insert failed:", error.message)
      })

    return NextResponse.json({ success: true, service, visible, status })
  } catch (error) {
    console.error("[USSD-SERVICE-VISIBILITY] POST error:", error)
    return NextResponse.json({ error: "Failed to update USSD service visibility" }, { status: 500 })
  }
}
