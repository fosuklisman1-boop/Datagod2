import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * Admin API to update user details (email, phone, password, name)
 * Syncs changes between Supabase Auth and the public.users table
 */
export async function POST(req: NextRequest) {
    try {
        // 1. Verify admin access
        const { isAdmin, errorResponse } = await verifyAdminAccess(req)
        if (!isAdmin) return errorResponse

        const { userId, email, phoneNumber, firstName, lastName, password } = await req.json()

        if (!userId) {
            return NextResponse.json({ error: "User ID is required" }, { status: 400 })
        }

        // Create admin client with service role
        const adminClient = createClient(supabaseUrl, serviceRoleKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        })

        console.log(`[ADMIN-UPDATE-USER] Updating user ${userId}...`)

        // 2. Update Supabase Auth
        const authUpdate: any = {}
        if (email) authUpdate.email = email
        if (password) authUpdate.password = password

        // Add role to metadata if we want to ensure it's preserved or updated
        // For now we just sync the basic fields

        let authError = null
        if (Object.keys(authUpdate).length > 0) {
            const { error } = await adminClient.auth.admin.updateUserById(userId, authUpdate)
            authError = error
        }

        if (authError) {
            console.error("[ADMIN-UPDATE-USER] Auth update error:", authError)
            return NextResponse.json({
                error: `Supabase Auth update failed: ${authError.message}`,
                details: authError
            }, { status: 400 })
        }

        // 3. Update public.users table
        const dbUpdate: any = {}
        if (email) dbUpdate.email = email
        if (phoneNumber) dbUpdate.phone_number = phoneNumber
        if (firstName !== undefined) dbUpdate.first_name = firstName
        if (lastName !== undefined) dbUpdate.last_name = lastName

        let dbError = null
        if (Object.keys(dbUpdate).length > 0) {
            dbUpdate.updated_at = new Date().toISOString()
            const { error } = await adminClient
                .from("users")
                .update(dbUpdate)
                .eq("id", userId)

            dbError = error
        }

        if (dbError) {
            console.error("[ADMIN-UPDATE-USER] Database update error:", dbError)
            // Note: Auth update might have succeeded but DB failed. 
            // This is a partial success state.
            return NextResponse.json({
                error: `Database update failed: ${dbError.message}. (Auth update might have succeeded)`,
                details: dbError
            }, { status: 400 })
        }

        console.log(`[ADMIN-UPDATE-USER] Successfully updated user ${userId}`)

        return NextResponse.json({
            success: true,
            message: "User updated successfully in both Auth and Database",
            updatedFields: {
                auth: Object.keys(authUpdate),
                database: Object.keys(dbUpdate)
            }
        })

    } catch (error: any) {
        console.error("[ADMIN-UPDATE-USER] Fatal error:", error)
        return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
    }
}
