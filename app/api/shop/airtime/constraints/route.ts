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
    // 1. Auth
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 2. Get User Role
    const { data: profile } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()
    
    const role = profile?.role || "customer"
    const suffix = (role === "dealer" || role === "admin") ? "dealer" : "customer"

    // 3. Fetch fees for each network
    const networks = ["mtn", "telecel", "at"]
    const constraints: Record<string, number> = {}

    for (const net of networks) {
      const feeSetting = await getAdminSetting(`airtime_fee_${net}_${suffix}`)
      const baseRate = feeSetting?.rate ?? 5 // Default 5%
      constraints[net] = Math.max(0, 10 - baseRate)
    }

    return NextResponse.json({
      success: true,
      role,
      maxMarkups: constraints,
      totalCap: 10
    })

  } catch (error) {
    console.error("[AIRTIME-CONSTRAINTS] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
