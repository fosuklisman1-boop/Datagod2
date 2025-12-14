import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface NotificationRequest {
  userId: string
  title: string
  message: string
  type: "balance_updated" | "admin_action" | "complaint_resolved" | "withdrawal_approved" | string
  reference_id: string
  action_url?: string
}

export async function POST(request: NextRequest) {
  try {
    const body: NotificationRequest = await request.json()
    const { userId, title, message, type, reference_id, action_url } = body

    // Validate required fields
    if (!userId || !title || !message || !type || !reference_id) {
      return NextResponse.json(
        { error: "Missing required fields: userId, title, message, type, reference_id" },
        { status: 400 }
      )
    }

    // Insert notification using service role (bypasses RLS)
    const { data, error } = await supabase
      .from("notifications")
      .insert([
        {
          user_id: userId,
          title,
          message,
          type,
          metadata: {
            reference_id,
            ...(action_url && { action_url }),
          },
          is_read: false,
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (error) {
      console.error("[ADMIN-NOTIFICATION] Error creating notification:", error)
      return NextResponse.json(
        { error: `Failed to create notification: ${error.message}` },
        { status: 500 }
      )
    }

    console.log(`[ADMIN-NOTIFICATION] Notification created for user ${userId}: "${title}"`)
    return NextResponse.json(
      { success: true, data },
      { status: 201 }
    )
  } catch (error) {
    console.error("[ADMIN-NOTIFICATION] Unexpected error:", error)
    return NextResponse.json(
      { error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    )
  }
}
