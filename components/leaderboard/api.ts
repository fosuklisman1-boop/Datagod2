import { supabase } from "@/lib/supabase"

export type LeaderboardResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

/** GET with the user's Bearer token; unwraps the `{ success, data }` envelope. Never throws. */
export async function leaderboardFetch<T>(path: string): Promise<LeaderboardResult<T>> {
  try {
    const { data } = await supabase.auth.getSession()
    const res = await fetch(path, { headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` } })
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null
    if (res.ok && body?.success) return { ok: true, data: body.data as T }
    return { ok: false, status: res.status, error: body?.error ?? `Request failed (${res.status})` }
  } catch {
    return { ok: false, status: 0, error: "Network error. Check your connection and try again." }
  }
}
