// Browser-side fetch helper for the admin user drawer's /api/admin/users/[id]/* routes.
import { supabase } from "@/lib/supabase"

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "AdminApiError"
  }
}

/** JSON request with the admin's access token; throws AdminApiError with the route's error message. */
export async function adminJson<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new AdminApiError("Session expired. Sign in again.", 401)
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
    cache: "no-store",
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new AdminApiError(data?.error || `Request failed (${res.status})`, res.status)
  return data as T
}

export const userApiPath = (userId: string, sub: string, params?: Record<string, string | number | null | undefined>) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v))
  const qs = sp.toString()
  return `/api/admin/users/${encodeURIComponent(userId)}/${sub}${qs ? `?${qs}` : ""}`
}
