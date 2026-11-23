"use client"

import { useEffect, useState } from "react"
import { DOCS_BAR_SPACE_PX } from "./SectionBar"

/**
 * Highlights the section whose card crosses the band just below the sticky chrome (IntersectionObserver scroll-spy).
 * Shared by DocsPage's SectionBar and the public sidebar, which nests the active page's sections.
 */
export function useScrollSpy(ids: string[], stickyTop: number): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0] ?? "")
  useEffect(() => {
    if (ids.length === 0) return
    const visible = new Map<string, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting)
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
        const next = atBottom ? ids[ids.length - 1] : ids.find((id) => visible.get(id))
        if (next) setActive(next)
      },
      { rootMargin: `-${DOCS_BAR_SPACE_PX + stickyTop}px 0px -55% 0px`, threshold: 0 }
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [ids, stickyTop])
  return [active, setActive]
}
