import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get("Authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            return NextResponse.json({ error: "No authorization token" }, { status: 401 })
        }

        const token = authHeader.slice(7)
        const { data: { user }, error: authError } = await supabase.auth.getUser(token)

        if (authError || !user) {
            console.error("[ADMIN-SUBSCRIPTIONS] Auth Error:", authError)
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        return fetchAllSubscriptions(user.id)
    } catch (error) {
        console.error("[ADMIN-SUBSCRIPTIONS] Error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}

async function fetchAllSubscriptions(adminId: string) {
    // Verify admin role
    const { data: adminUser } = await supabase
        .from("users")
        .select("role")
        .eq("id", adminId)
        .single()

    if (adminUser?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 })
    }

    // Fetch subscriptions with plan details first
    const { data: rawSubscriptions, error } = await supabase
        .from("user_subscriptions")
        .select(`
      *,
      plan:subscription_plans(name, duration_days)
    `)
        .order("end_date", { ascending: false })

    if (error) {
        console.error("[ADMIN-SUBSCRIPTIONS] DB Error:", error)
        return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 })
    }

    // Fetch user details manually
    if (rawSubscriptions && rawSubscriptions.length > 0) {
        const userIds = Array.from(new Set(rawSubscriptions.map(sub => sub.user_id)))

        const { data: users, error: userError } = await supabase
            .from("users")
            .select("id, first_name, last_name, email, phone_number")
            .in("id", userIds)

        if (userError) {
            console.error("[ADMIN-SUBSCRIPTIONS] User Fetch Error:", userError)
            // Proceed without user details if fetch fails, but log it
        }

        const subscriptions = rawSubscriptions.map(sub => ({
            ...sub,
            user: users?.find(u => u.id === sub.user_id) || null
        }))

        return NextResponse.json({ subscriptions })
    }

    return NextResponse.json({ subscriptions: [] })
}
