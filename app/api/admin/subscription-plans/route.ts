import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

async function verifyAdmin(request: NextRequest) {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
        return { error: "No authorization token", status: 401 }
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
        return { error: "Unauthorized", status: 401 }
    }

    const { data: dbUser } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single()

    if (dbUser?.role !== "admin") {
        return { error: "Forbidden: Admin access required", status: 403 }
    }

    return { user }
}

export async function GET(request: NextRequest) {
    try {
        const { data, error } = await supabase
            .from("subscription_plans")
            .select("*")
            .order("price", { ascending: true })

        if (error) throw error

        return NextResponse.json({ plans: data })
    } catch (error) {
        console.error("Error fetching plans:", error)
        return NextResponse.json({ error: "Failed to fetch plans" }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await verifyAdmin(request)
        if (auth.error) {
            return NextResponse.json({ error: auth.error }, { status: auth.status })
        }

        const body = await request.json()
        const { id, name, description, price, duration_days, is_active } = body

        if (!name || !price || !duration_days) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
        }

        const planData = {
            name,
            description,
            price: parseFloat(price),
            duration_days: parseInt(duration_days),
            is_active: is_active ?? true,
            updated_at: new Date().toISOString()
        }

        let result
        if (id) {
            // Update
            result = await supabase
                .from("subscription_plans")
                .update(planData)
                .eq("id", id)
                .select()
                .single()
        } else {
            // Create
            result = await supabase
                .from("subscription_plans")
                .insert([{ ...planData, created_at: new Date().toISOString() }])
                .select()
                .single()
        }

        if (result.error) throw result.error

        return NextResponse.json({ success: true, plan: result.data })
    } catch (error) {
        console.error("Error saving plan:", error)
        return NextResponse.json({ error: "Failed to save plan" }, { status: 500 })
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const auth = await verifyAdmin(request)
        if (auth.error) {
            return NextResponse.json({ error: auth.error }, { status: auth.status })
        }

        const { searchParams } = new URL(request.url)
        const id = searchParams.get("id")

        if (!id) {
            return NextResponse.json({ error: "Missing plan ID" }, { status: 400 })
        }

        const { error } = await supabase
            .from("subscription_plans")
            .delete()
            .eq("id", id)

        if (error) throw error

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error("Error deleting plan:", error)
        return NextResponse.json({ error: "Failed to delete plan" }, { status: 500 })
    }
}
