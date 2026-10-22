import { supabase } from "@/lib/supabase"

export interface FetchResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: string | null
}

/** Admin fetch with the Supabase session bearer token (same pattern as the old page). Never throws. */
export async function adminFetch<T>(url: string, init: RequestInit = {}): Promise<FetchResult<T>> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
    if (init.body !== undefined) headers["Content-Type"] = "application/json"
    const res = await fetch(url, { ...init, headers })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    const errText =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : null
    return {
      ok: res.ok,
      status: res.status,
      data: res.ok ? (data as T) : null,
      error: res.ok ? null : errText || `Request failed (${res.status})`,
    }
  } catch {
    return { ok: false, status: 0, data: null, error: "Network error" }
  }
}
