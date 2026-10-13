"use client"

import { useEffect, useRef, useState } from "react"

export type PwaInstallMode = "android" | "ios" | "manual" | "installed"

type DeferredPrompt = Event & { prompt: () => Promise<void> }

// "android" = browser-native prompt available, "ios" = Safari Add-to-Home-Screen
// guide, "manual" = installable in principle but no prompt captured (desktop,
// or the browser hasn't fired beforeinstallprompt yet), "installed" = already
// running as a standalone app.
export function usePwaInstall() {
  const [mode, setMode] = useState<PwaInstallMode>("manual")
  const deferredPrompt = useRef<DeferredPrompt | null>(null)

  useEffect(() => {
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    if (isStandalone) {
      setMode("installed")
      return
    }

    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      setMode("ios")
      return
    }

    // The inline <head> script in app/layout.tsx may have captured the event
    // before hydration.
    const w = window as Window & { __deferredInstallPrompt?: DeferredPrompt }
    if (w.__deferredInstallPrompt) {
      deferredPrompt.current = w.__deferredInstallPrompt
      setMode("android")
      return
    }

    const handler = (e: Event) => {
      if (e.type === "beforeinstallprompt") e.preventDefault()
      const prompt = e.type === "pwaInstallReady" ? w.__deferredInstallPrompt : (e as DeferredPrompt)
      if (!prompt) return
      deferredPrompt.current = prompt
      setMode("android")
    }
    window.addEventListener("beforeinstallprompt", handler)
    window.addEventListener("pwaInstallReady", handler)
    return () => {
      window.removeEventListener("beforeinstallprompt", handler)
      window.removeEventListener("pwaInstallReady", handler)
    }
  }, [])

  const promptInstall = async () => {
    if (!deferredPrompt.current) return false
    await deferredPrompt.current.prompt()
    deferredPrompt.current = null
    setMode("manual")
    return true
  }

  return { mode, promptInstall }
}
