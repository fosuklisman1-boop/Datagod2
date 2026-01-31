import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get("Authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            // Check for session cookie/auth if no header (client-side fetch might use it)
            const { data: { user }, error: authError } = await supabase.auth.getUser()
            if (authError || !user) {
                return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
            }
            return fetchSubscription(user.id)
        }

        const token = authHeader.slice(7)
        const { data: { user }, error: authError } = await supabase.auth.getUser(token)

        if (authError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        return fetchSubscription(user.id)
    } catch (error) {
        console.error("[SUBSCRIPTION-CURRENT] Error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}

async function fetchSubscription(userId: string) {
    const { data: subscription, error } = await supabase
        .from("user_subscriptions")
        .select(`
      *,
      plan:subscription_plans(*)
    `)
        .eq("user_id", userId)
        .eq("status", "active")
        .order("end_date", { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error("[SUBSCRIPTION-CURRENT] DB Error:", error)
        return NextResponse.json({ error: "Failed to fetch subscription" }, { status: 500 })
    }

    return NextResponse.json({ subscription })
}
