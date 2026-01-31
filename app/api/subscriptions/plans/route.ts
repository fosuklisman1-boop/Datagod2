import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
    try {
        const { data, error } = await supabase
            .from("subscription_plans")
            .select("id, name, description, price, duration_days")
            .eq("is_active", true)
            .order("price", { ascending: true })

        if (error) throw error

        return NextResponse.json({ plans: data })
    } catch (error) {
        console.error("Error fetching plans:", error)
        return NextResponse.json({ error: "Failed to fetch plans" }, { status: 500 })
    }
}
