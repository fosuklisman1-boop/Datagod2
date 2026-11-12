import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { NextRequest } from "next/server"

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
