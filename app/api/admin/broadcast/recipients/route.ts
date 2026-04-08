import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(req: NextRequest) {
    const { isAdmin, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) return errorResponse

    try {
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
