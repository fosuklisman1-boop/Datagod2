import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
    try {
        const supabase = createRouteHandlerClient({ cookies })

        // 1. Auth Check
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Check if admin
        const { data: userRole } = await supabase
            .from("users")
            .select("role")
            .eq("id", session.user.id)
            .single()

        if (userRole?.role !== "admin") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        // 2. Initialize Admin Client to bypass RLS
        // We need to use the service role key to fetch ALL users
        const adminUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY

        if (!adminUrl || !adminKey) {
            return NextResponse.json({ error: "Server configuration error" }, { status: 500 })
        }

        const { createClient } = await import("@supabase/supabase-js")
        const adminClient = createClient(adminUrl, adminKey, {
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
