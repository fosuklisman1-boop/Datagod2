"use client"

import { supabase } from "@/lib/supabase"
import type { GatewayConfig } from "@/lib/payment-gateway/config"
import { pickGatewaySettings, type GatewayPageSettingsKey } from "./fee-fields"

/** The five admin_settings values the gateway page owns. */
export type GatewaySettingsValues = Record<GatewayPageSettingsKey, number>

export interface HubtelReadiness {
  ready: boolean
  missing: string[]
}

async function authHeaders(json = false): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("Authentication required")
  const h: Record<string, string> = { Authorization: `Bearer ${session.access_token}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

/** fetch with the admin bearer token; throws with the route's error message on non-2xx. */
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
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  return data as T
}

export async function putGatewayConfig(config: GatewayConfig): Promise<GatewayConfig> {
  const data = await adminFetch<{ config: GatewayConfig }>("/api/admin/gateway", { method: "PUT", body: { config } })
  return data.config
}

/**
 * PUT only the named fee/withdrawal keys to /api/admin/settings. The route
 * updates only keys present in the body, so each card can never reset values
 * it does not own. Throws (sending nothing) if any named value is not a finite number.
 */
export async function putGatewaySettings(
  values: Record<string, unknown>,
  keys: readonly GatewayPageSettingsKey[],
): Promise<void> {
  const picked = pickGatewaySettings(values)
  const body: Partial<Record<GatewayPageSettingsKey, number>> = {}
  for (const k of keys) {
    if (picked[k] === undefined) throw new Error("Enter a valid number in every field")
    body[k] = picked[k]
  }
  await adminFetch("/api/admin/settings", { method: "PUT", body })
}
