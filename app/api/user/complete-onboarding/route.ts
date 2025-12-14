import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { userId } = await request.json()

    if (!userId) {
      return NextResponse.json(
        { error: "User ID is required" },
        { status: 400 }
      )
    }

    // Update user's onboarding status
    const { data, error } = await supabase
      .from("users")
      .update({
        onboarding_completed: true,
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select()

    if (error) {
      console.error("Error updating onboarding status:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      data: data?.[0],
    })
  } catch (error: any) {
    console.error("Error in complete-onboarding route:", error)
    return NextResponse.json(
      { error: error?.message || "Failed to complete onboarding" },
      { status: 500 }
    )
  }
}
