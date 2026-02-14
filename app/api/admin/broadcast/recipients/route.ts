import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(req: NextRequest) {
    try {
        // 1. Auth Check (Manual verification since auth-helpers is not installed)
        const authHeader = req.headers.get("Authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            return NextResponse.json({ error: "Unauthorized: Missing auth token" }, { status: 401 })
        }

        const token = authHeader.slice(7)
        const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
        const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token)

        if (authError || !user) {
            return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
        }

        // Check if admin
        let isAdmin = user.user_metadata?.role === "admin"
        if (!isAdmin) {
            // Fallback check in users table
            const { data: userData } = await supabaseClient
                .from("users")
                .select("role")
                .eq("id", user.id)
                .single()

            if (userData?.role === "admin") isAdmin = true
        }

        if (!isAdmin) {
            return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 })
        }

        // 2. Initialize Admin Client to bypass RLS
        const adminClient = createClient(supabaseUrl, serviceRoleKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        })

        // 3. Recursive Fetch Logic (Server-Side)
        let allUsers: any[] = []
        let page = 0
        const pageSize = 1000
        let hasMore = true

        while (hasMore) {
            // Use listUsers for auth users or select from public schema?
            // usage in lib/admin-service.ts was querying 'users' table, so we stick to that.
            const { data, error } = await adminClient
                .from("users")
                .select("id, email, phone_number, first_name, role")
                .range(page * pageSize, (page + 1) * pageSize - 1)
                .order("created_at", { ascending: false })

            if (error) throw error

            if (data && data.length > 0) {
                allUsers = [...allUsers, ...data]
                if (data.length < pageSize) hasMore = false
                page++
            } else {
                hasMore = false
            }
        }

        return NextResponse.json(allUsers)

    } catch (error: any) {
        console.error("Error fetching broadcast recipients:", error)
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
    }
}
