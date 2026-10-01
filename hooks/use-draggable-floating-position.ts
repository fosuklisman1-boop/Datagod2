"use client"

import { useCallback, useEffect, useRef, useState } from "react"

const DRAG_THRESHOLD_PX = 6
const EDGE_PADDING_PX = 8

export interface DraggablePosition {
  top: number
  left: number
}

/**
 * Makes a fixed-position floating element user-draggable, persisting the
 * chosen spot in localStorage. Until the user drags it once, the caller's
 * own responsive Tailwind classes control position (`position` stays null);
 * after a drag, this hook returns an absolute pixel position, clamped to
 * stay fully on-screen, which the caller applies as an inline style instead.
 */
export function useDraggableFloatingPosition(storageKey: string) {
  const [position, setPosition] = useState<DraggablePosition | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startX: number; startY: number; originLeft: number; originTop: number; dragging: boolean } | null>(null)
  const didDragRef = useRef(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (typeof parsed?.top === "number" && typeof parsed?.left === "number") {
          setPosition(parsed)
        }
      }
    } catch {}
  }, [storageKey])

  const clamp = useCallback((top: number, left: number) => {
    const el = containerRef.current
    const w = el?.offsetWidth ?? 60
    const h = el?.offsetHeight ?? 60
    const maxLeft = Math.max(EDGE_PADDING_PX, window.innerWidth - w - EDGE_PADDING_PX)
    const maxTop = Math.max(EDGE_PADDING_PX, window.innerHeight - h - EDGE_PADDING_PX)
    return {
      left: Math.min(Math.max(EDGE_PADDING_PX, left), maxLeft),
      top: Math.min(Math.max(EDGE_PADDING_PX, top), maxTop),
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragState.current = { startX: e.clientX, startY: e.clientY, originLeft: rect.left, originTop: rect.top, dragging: false }

    const handleMove = (ev: PointerEvent) => {
      const ds = dragState.current
      if (!ds) return
      const dx = ev.clientX - ds.startX
      const dy = ev.clientY - ds.startY
      if (!ds.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      ds.dragging = true
      didDragRef.current = true
      setPosition(clamp(ds.originTop + dy, ds.originLeft + dx))
    }

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
      const ds = dragState.current
      dragState.current = null
      if (ds?.dragging) {
        setPosition(prev => {
          if (prev) {
            try { localStorage.setItem(storageKey, JSON.stringify(prev)) } catch {}
          }
          return prev
        })
      }
    }

    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
  }, [clamp, storageKey])

  // The browser fires a click on pointerup regardless of how far the pointer
  // moved — this swallows that click when it was actually a drag, so dragging
  // the group doesn't also toggle the chat open or trigger a hard refresh.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (didDragRef.current) {
      e.preventDefault()
      e.stopPropagation()
      didDragRef.current = false
    }
  }, [])

  // Re-clamp on viewport resize so a previously-dragged position never ends
  // up off-screen (e.g. rotating a phone, or resizing a desktop window).
  useEffect(() => {
    if (!position) return
    const onResize = () => setPosition(p => (p ? clamp(p.top, p.left) : p))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [position, clamp])

  return { position, containerRef, onPointerDown, onClickCapture }
}
