import { supabase } from "@/lib/supabase"

/** Current admin access token (empty string if not signed in). */
export async function authToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ""
}

export interface ApiResult<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Thin fetch wrapper for the admin SMS Centre routes. Attaches the bearer token,
 * sets JSON content-type when there's a body, and always resolves to the
 * { success, data?, error? } envelope the routes return.
 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const t = await authToken()
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${t}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
    })
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Network error" }
  }
  try {
    return (await res.json()) as ApiResult<T>
  } catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}
