import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

let client: SupabaseClient | null = null

/** Service-role client. Bypasses RLS, so every read must filter by the caller. */
export function getSupportDb(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  }
  return client
}

/** Resolve the caller from the Bearer token. Null for a missing/malformed header, auth error or no user. */
export async function getSupportUser(request: NextRequest): Promise<{ userId: string } | null> {
  const header = request.headers.get("Authorization")
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice(7)
  if (!token) return null
  try {
    const { data, error } = await getSupportDb().auth.getUser(token)
    if (error || !data?.user) return null
    return { userId: data.user.id }
  } catch {
    return null
  }
}

/**
 * Admin gate for support routes. verifyAdminAccess also admits the cron-secret bearer, which has
 * no user id; replies and closes are attributed to a person, so that caller is refused here.
 */
export async function requireSupportAdmin(request: NextRequest): Promise<{ adminId: string } | { response: NextResponse }> {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) {
    return { response: auth.errorResponse ?? NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) }
  }
  if (!auth.userId) return { response: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) }
  return { adminId: auth.userId }
}
