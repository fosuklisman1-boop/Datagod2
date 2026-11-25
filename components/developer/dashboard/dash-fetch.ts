"use client"

import { supabase } from "@/lib/supabase"

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

export type DashResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Session-authenticated JSON call to /api/user/v2-dashboard/*. Never throws. */
export async function dashJson<T>(path: string, init: { method?: "GET" | "PUT"; body?: unknown } = {}): Promise<DashResult<T>> {
  try {
    const res = await fetch(path, {
      method: init.method ?? "GET",
      cache: "no-store",
      headers: { ...(await authHeader()), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: typeof data.error === "string" ? data.error : "Something went wrong. Try again." }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, error: "Network error. Check your connection and try again." }
  }
}

/** Downloads a session-authenticated file (the CSV). Returns an error message or null. */
export async function dashDownload(path: string, fallbackName: string): Promise<string | null> {
  try {
    const res = await fetch(path, { cache: "no-store", headers: await authHeader() })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: unknown }
      return typeof data.error === "string" ? data.error : "The download failed. Try again."
    }
    const blob = await res.blob()
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return res.headers.get("X-Row-Cap-Reached") === "1" ? "Downloaded the first 5,000 orders. Narrow the dates for the rest." : null
  } catch {
    return "Network error. Check your connection and try again."
  }
}
