"use client"

import { supabase } from "@/lib/supabase"
import type { HubRole } from "./ladder-view"

async function authHeaders(json = false): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("Authentication required")
  const h: Record<string, string> = { Authorization: `Bearer ${session.access_token}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

/** Error from a non-2xx response; carries the status so callers can react to a 409. */
export class ApiError extends Error {
  status: number
  /** The parsed JSON body of the failed response (for example `below_cost` on a 409). */
  data: Record<string, unknown>
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.data = data
  }
}

/** fetch with the admin bearer token; throws ApiError with the route's message on non-2xx. */
export async function adminFetch<T = Record<string, unknown>>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const hasBody = init?.body !== undefined
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: await authHeaders(hasBody),
    body: hasBody ? JSON.stringify(init!.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string }).error || `Request failed (${res.status})`,
      res.status,
      data && typeof data === "object" ? (data as Record<string, unknown>) : {},
    )
  }
  return data as T
}

export interface RolesListResponse {
  roles: HubRole[]
  package_total: number
}

export const fetchRoles = () => adminFetch<RolesListResponse>("/api/admin/roles")

export interface AuditEntry {
  at: string
  actor_id: string | null
  actor_email: string | null
  action: string
  summary: string
  reason: string | null
  loss_override: boolean
}

export const fetchAudit = (id: string, page: number) =>
  adminFetch<{ entries: AuditEntry[]; page: number; has_more: boolean }>(`/api/admin/roles/${id}/audit?page=${page}`)
