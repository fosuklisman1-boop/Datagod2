import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {

  // Get current user
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    console.log("[TEST-NOTIFICATIONS] Auth error:", authError)
    return NextResponse.json(
      { error: "Unauthorized", details: authError?.message },
      { status: 401 }
    )
  }

  try {
    // Test 1: Check if notifications table exists
    console.log("[TEST-NOTIFICATIONS] Testing notifications table...")
    const { data: tableTest, error: tableError } = await supabase
      .from("notifications")
      .select("*")
      .limit(1)

    if (tableError?.code === "PGRST116") {
      return NextResponse.json(
        {
          status: "ERROR",
          error: "Notifications table does not exist",
          message: "You need to run the SQL migration in Supabase",
          steps: [
            "1. Go to Supabase Dashboard → SQL Editor",
            "2. Copy content from migrations/create_notifications_table.sql",
            "3. Execute the SQL",
          ],
          technical: tableError,
        },
        { status: 500 }
      )
    }

    if (tableError) {
      return NextResponse.json(
        {
          status: "ERROR",
          error: tableError.message,
          code: tableError.code,
          details: tableError.details,
          hint: tableError.hint,
        },
        { status: 500 }
      )
    }

    // Test 2: Try to create a test notification
    console.log("[TEST-NOTIFICATIONS] Creating test notification for user:", user.id)
    const { data: insertData, error: insertError } = await supabase
      .from("notifications")
      .insert([
        {
          user_id: user.id,
          title: "Test Notification",
          message: `This is a test notification created at ${new Date().toISOString()}`,
          type: "order_update",
          read: false,
        },
      ])
      .select()

    if (insertError) {
      return NextResponse.json(
        {
          status: "ERROR",
          error: "Failed to create notification",
          code: insertError.code,
          message: insertError.message,
          details: insertError.details,
          hint: insertError.hint,
          userId: user.id,
          suggestions: [
            "Check RLS policies are correct",
            "Check user_id is valid UUID",
            "Check SUPABASE_SERVICE_ROLE_KEY is set",
          ],
        },
        { status: 500 }
      )
    }

    // Test 3: Fetch the created notification
    console.log("[TEST-NOTIFICATIONS] Fetching user notifications...")
    const { data: fetchData, error: fetchError } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10)

    if (fetchError) {
      return NextResponse.json(
        {
          status: "ERROR",
          error: "Failed to fetch notifications",
          code: fetchError.code,
          message: fetchError.message,
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      status: "SUCCESS",
      message: "All notification tests passed ✓",
      user: {
        id: user.id,
        email: user.email,
      },
      tests: {
        tableExists: true,
        notificationCreated: !!insertData?.[0],
        createdId: insertData?.[0]?.id,
      },
      recentNotifications: fetchData,
      totalNotifications: fetchData?.length || 0,
    })
  } catch (error) {
    console.error("[TEST-NOTIFICATIONS] Unexpected error:", error)
    return NextResponse.json(
      {
        status: "ERROR",
        error: "Unexpected error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  // Get current user from authorization header
  const authHeader = request.headers.get("authorization")
  
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    )
  }

  // For testing, we'll allow POST with a token
  const token = authHeader.split(" ")[1]

  const body = await request.json()
  const { title = "Test", message = "Test message", type = "order_update", userId } = body

  if (!userId) {
    return NextResponse.json(
      { error: "userId required in request body" },
      { status: 400 }
    )
  }

  try {
    const { data, error } = await supabase
      .from("notifications")
      .insert([
        {
          user_id: userId,
          title,
          message,
          type,
          read: false,
        },
      ])
      .select()

    if (error) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      notification: data?.[0],
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
