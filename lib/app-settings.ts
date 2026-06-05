import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Small in-memory cache — the community link changes rarely, and these reads
// happen on hot paths (webhooks, USSD handlers). TTL keeps it fresh enough.
const TTL_MS = 5 * 60 * 1000
let cached: { link: string; at: number } | null = null

/**
 * Fetch the public "join community" / channel link from app_settings.
 * Returns "" if unset or on error so callers can safely skip appending it.
 */
export async function getJoinCommunityLink(): Promise<string> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.link

  try {
    const { data } = await supabase
      .from("app_settings")
      .select("join_community_link")
      .limit(1)
      .single()

    const link = (data?.join_community_link ?? "").trim()
    cached = { link, at: Date.now() }
    return link
  } catch {
    // On error, fall back to the last known value (if any) rather than failing the SMS
    return cached?.link ?? ""
  }
}
