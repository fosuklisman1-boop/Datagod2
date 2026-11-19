"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { supabase } from "@/lib/supabase"
import { EMPTY_RIGHTS, parseRoleResponse, resolveSkin, type RightsState, type RoleInfo, type RoleSkin } from "@/lib/roles/client-rights"

export type RoleRightsResult = RightsState & { info: RoleInfo | null; skin: RoleSkin }

// One request shared by every component that asks within a short window (sidebar, bottom nav, landing hook).
let inflight: { at: number; promise: Promise<RoleInfo | null> } | null = null

async function fetchRoleInfo(): Promise<RoleInfo | null> {
  const now = Date.now()
  if (inflight && now - inflight.at < 2000) return inflight.promise
  const promise = (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return null
      const res = await fetch("/api/user/role", { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (!res.ok) return null
      return parseRoleResponse(await res.json())
    } catch {
      return null
    }
  })()
  inflight = { at: now, promise }
  return promise
}

function cached(key: string): string | null {
  try {
    return typeof window !== "undefined" ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}
const cachedSlug = () => cached("userRole")

/**
 * The caller's role rights from /api/user/role, refetched on every route change. While loading or after a
 * failure rights are the empty set (only always-on items show); the cached slug is for first paint only.
 */
export function useRoleRights(): RoleRightsResult {
  const pathname = usePathname()
  const [state, setState] = useState<RightsState & { info: RoleInfo | null }>(() => ({
    status: "loading",
    slug: null,
    rights: EMPTY_RIGHTS,
    info: null,
  }))

  useEffect(() => {
    let cancelled = false
    fetchRoleInfo().then((info) => {
      if (cancelled) return
      if (info) {
        try {
          localStorage.setItem("userRole", info.slug)
          localStorage.setItem("userSkin", info.skin)
        } catch { /* storage blocked */ }
        setState({ status: "ok", slug: info.slug, rights: info.rights, info })
      } else {
        setState((prev) => ({ status: "error", slug: prev.slug ?? cachedSlug(), rights: EMPTY_RIGHTS, info: null }))
      }
    })
    return () => { cancelled = true }
  }, [pathname])

  // Fetched skin always wins; until then the cached skin (or a cached dealer slug) paints the first frame.
  const slug = state.slug ?? cachedSlug()
  const skin = resolveSkin(state.info?.skin ?? null, cached("userSkin"), slug)
  if (state.status === "loading" && state.slug === null) return { ...state, slug, skin }
  return { ...state, skin }
}
