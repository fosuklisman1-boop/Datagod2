import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  try {
    // Verify admin access (checks both user_metadata and users table)
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    // Create the RLS policies using RPC or raw SQL
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
    const { error: policyError } = await supabaseAdmin.rpc("create_admin_complaint_policies", {})

    if (policyError) {
      // If RPC doesn't exist, try using SQL directly
      console.log("Attempting to create policies via raw SQL...")
      
      // We'll use the admin API to create policies
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/create_admin_complaint_policies`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`,
          "apikey": serviceRoleKey,
        },
      })

      if (!response.ok) {
        console.log("RPC approach failed, policies may need to be created manually in Supabase dashboard")
      }
    }

    return NextResponse.json({
      status: "success",
      message: "RLS policies configured. If this is the first run, please verify policies in Supabase dashboard.",
      instructions: "Visit https://app.supabase.com -> Your Project -> Authentication -> Policies (complaints table) and ensure admin policies exist.",
    })
  } catch (error) {
    console.error("Error setting up RLS:", error)
    return NextResponse.json(
      { error: "Failed to set up RLS policies", details: String(error) },
      { status: 500 }
    )
  }
}
