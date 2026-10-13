import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

/** Bearer-token auth, same pattern as app/api/airtime/purchase/route.ts. Never leaks internals. */
export async function authenticate(request: NextRequest): Promise<{ userId: string } | { response: NextResponse }> {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { response: NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 }) }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.slice(7))
  if (error || !user) return { response: NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 }) }
  return { userId: user.id }
}

export const readJson = async (request: NextRequest): Promise<Record<string, unknown> | null> => {
  try {
    const b = await request.json()
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch { return null }
}
