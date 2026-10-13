"use client"

import { useCallback, useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import {
  isNavNew,
  isRegisteredNavHref,
  parseNavClicksPayload,
  recordNavClick,
  type NavClicks,
} from "@/lib/nav-new"

/*
 * Client side of the sidebar NEW tag (logic + registry: lib/nav-new.ts).
 *
 * - Nothing is tagged until GET /api/user/nav-new has answered for this user:
 *   no tag during SSR / first paint (no hydration mismatch) and no tag flash on
 *   items the user already cleared on another device.
 * - Fail quiet: any GET failure (incl. the migration not applied yet) leaves
 *   clicks = null, which shows NO tags anywhere.
 * - markClicked() is optimistic (increment, cap 2) and POSTs fire-and-forget;
 *   errors are ignored and never block navigation.
 * - One module-level store per user, so every Sidebar instance shares ONE fetch
 *   and sees the same clicks.
 */

type Store = { clicks: NavClicks | null; loading: Promise<void> | null; listeners: Set<() => void> }
const stores = new Map<string, Store>()

function getStore(userId: string): Store {
  let s = stores.get(userId)
  if (!s) {
    s = { clicks: null, loading: null, listeners: new Set() }
    stores.set(userId, s)
  }
  return s
}

function emit(s: Store) {
  s.listeners.forEach(fn => fn())
}

async function authHeader(): Promise<Record<string, string> | null> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : null
}

function ensureLoaded(userId: string, s: Store) {
  if (s.clicks !== null || s.loading) return
  s.loading = (async () => {
    try {
      const headers = await authHeader()
      if (!headers) return
      const res = await fetch("/api/user/nav-new", { headers, cache: "no-store" })
      if (!res.ok) return
      const parsed = parseNavClicksPayload(await res.json().catch(() => null))
      if (parsed && s.clicks === null) {
        s.clicks = parsed
        emit(s)
      }
    } catch {
      // Fail quiet: no tags. A failed load is not retried within this page
      // session (s.loading stays set, so no request storms); a reload retries.
    }
  })()
}

function postClick(href: string) {
  void (async () => {
    try {
      const headers = await authHeader()
      if (!headers) return
      await fetch("/api/user/nav-new", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ href }),
        keepalive: true,
      })
    } catch {
      // fire-and-forget: keep the optimistic state for this session
    }
  })()
}

export function useNavNew(userId: string | null | undefined) {
  const [clicks, setClicks] = useState<NavClicks | null>(null)

  useEffect(() => {
    if (!userId) {
      setClicks(null)
      return
    }
    const s = getStore(userId)
    const sync = () => setClicks(s.clicks)
    s.listeners.add(sync)
    sync()
    ensureLoaded(userId, s)
    return () => {
      s.listeners.delete(sync)
    }
  }, [userId])

  const isNew = useCallback((href: string) => isNavNew(href, clicks), [clicks])

  const markClicked = useCallback(
    (href: string) => {
      if (!userId || !isRegisteredNavHref(href)) return
      const s = getStore(userId)
      // Only count clicks on a tag the user could actually see: if the load is
      // pending or failed (clicks === null) nothing is shown, so nothing is counted.
      if (s.clicks === null || !isNavNew(href, s.clicks)) return
      s.clicks = recordNavClick(s.clicks, href)
      emit(s)
      postClick(href)
    },
    [userId]
  )

  return { isNew, markClicked }
}
