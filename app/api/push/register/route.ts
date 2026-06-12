import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Registers/unregisters a mobile device's Expo push token for the caller.
// device_push_tokens has RLS enabled with no policies, so all access goes
// through this service-role route.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function authedUser(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return null
  const { data: { user } } = await supabaseAdmin.auth.getUser(authHeader.substring(7))
  return user
}

export async function POST(request: NextRequest) {
  const user = await authedUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const { token, platform, deviceName } = body || {}
  if (typeof token !== "string" || !/^Expo(nent)?PushToken\[.+\]$/.test(token)) {
    return NextResponse.json({ error: "Invalid push token" }, { status: 400 })
  }
  if (platform !== "ios" && platform !== "android") {
    return NextResponse.json({ error: "Invalid platform" }, { status: 400 })
  }

  // Token is the conflict key: a device that switches accounts re-binds its
  // token to the new user instead of creating a duplicate row.
  const { error } = await supabaseAdmin.from("device_push_tokens").upsert(
    {
      user_id: user.id,
      token,
      platform,
      device_name: typeof deviceName === "string" ? deviceName.slice(0, 120) : null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "token" }
  )
  if (error) {
    console.error("[PUSH-REGISTER] Upsert failed:", error.message)
    return NextResponse.json({ error: "Failed to register device" }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const user = await authedUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const { token } = body || {}
  if (typeof token !== "string") {
    return NextResponse.json({ error: "token is required" }, { status: 400 })
  }
  await supabaseAdmin.from("device_push_tokens").delete().eq("token", token).eq("user_id", user.id)
  return NextResponse.json({ success: true })
}
