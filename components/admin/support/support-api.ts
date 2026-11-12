"use client"

import { useEffect, useRef } from "react"
import { supabase } from "@/lib/supabase"

export interface ApiResult<T> {
  ok: boolean
  status: number
  data?: T
  error?: string
}

/** Authenticated call to an admin support route that answers `{ success, data | error }`. */
export async function adminApi<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<ApiResult<T>> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.access_token) return { ok: false, status: 401, error: "Not authenticated" }
    const res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    })
    const json = await res.json().catch(() => null)
    if (res.ok && json?.success) return { ok: true, status: res.status, data: json.data as T }
    return { ok: false, status: res.status, error: json?.error ?? "Something went wrong. Please try again." }
  } catch {
    return { ok: false, status: 0, error: "Network error. Please try again." }
  }
}

/**
 * Runs `task` every `intervalMs` while `enabled`. Ticks are skipped while the tab is hidden
 * or while the previous run is still in flight; the timer is cleared on unmount / disable.
 */
export function usePolling(task: () => Promise<void>, intervalMs: number, enabled: boolean) {
  const taskRef = useRef(task)
  useEffect(() => {
    taskRef.current = task
  })

  useEffect(() => {
    if (!enabled) return
    let inFlight = false
    const run = async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      try {
        await taskRef.current()
      } finally {
        inFlight = false
      }
    }
    const id = setInterval(run, intervalMs)
    // Catch up as soon as the tab is visible again instead of waiting for the next tick.
    document.addEventListener("visibilitychange", run)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", run)
    }
  }, [intervalMs, enabled])
}
