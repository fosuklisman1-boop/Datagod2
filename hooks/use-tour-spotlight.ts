"use client"

import { useEffect, useState } from "react"

interface TourSpotlight {
  element: HTMLElement | null
  position: {
    top: number
    left: number
    width: number
    height: number
  }
}

interface UseTourSpotlightReturn {
  spotlight: TourSpotlight | null
  highlightElement: (selector: string) => void
  clearSpotlight: () => void
}

export function useTourSpotlight(): UseTourSpotlightReturn {
  const [spotlight, setSpotlight] = useState<TourSpotlight | null>(null)

  const highlightElement = (selector: string) => {
    const element = document.querySelector(selector) as HTMLElement
    if (!element) {
      console.warn(`Element not found: ${selector}`)
      clearSpotlight()
      return
    }

    const rect = element.getBoundingClientRect()
    setSpotlight({
      element,
      position: {
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        height: rect.height,
      },
    })

    // Scroll element into view
    element.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  const clearSpotlight = () => {
    setSpotlight(null)
  }

  // Update position on scroll/resize
  useEffect(() => {
    if (!spotlight?.element) return

    const handleScroll = () => {
      const rect = spotlight.element!.getBoundingClientRect()
      setSpotlight((prev) =>
        prev
          ? {
              ...prev,
              position: {
                top: rect.top + window.scrollY,
                left: rect.left + window.scrollX,
                width: rect.width,
                height: rect.height,
              },
            }
          : null
      )
    }

    window.addEventListener("scroll", handleScroll)
    window.addEventListener("resize", handleScroll)
    return () => {
      window.removeEventListener("scroll", handleScroll)
      window.removeEventListener("resize", handleScroll)
    }
  }, [spotlight?.element])

  return { spotlight, highlightElement, clearSpotlight }
}
