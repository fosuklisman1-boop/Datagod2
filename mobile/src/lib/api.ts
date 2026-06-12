import { API_BASE_URL } from "./config"
import { supabase } from "./supabase"

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/**
 * Authenticated fetch against the Datagod backend.
 * - Adds Authorization: Bearer <access_token>
 * - On 401, refreshes the session once and retries; if that fails the caller
 *   gets an ApiError(401) and the auth gate signs the user out.
 */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = async (token: string | null) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    }
    if (token) headers["Authorization"] = `Bearer ${token}`
    return fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  }

  let res = await doFetch(await getAccessToken())

  if (res.status === 401) {
    // Token may be expired or its session revoked — try one refresh, then retry.
    const { data, error } = await supabase.auth.refreshSession()
    if (!error && data.session?.access_token) {
      res = await doFetch(data.session.access_token)
    }
    if (res.status === 401) {
      // Refresh failed or the token is still rejected — the session is dead
      // (e.g. refresh-token family revoked). Sign out locally so the auth
      // gate returns the user to the login screen instead of leaving every
      // screen stuck on "Unauthorized".
      supabase.auth.signOut({ scope: "local" }).catch(() => {})
    }
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(body?.error || `Request failed (${res.status})`, res.status)
  }
  return body as T
}
