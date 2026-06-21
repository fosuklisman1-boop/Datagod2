"use client"

import { useEffect, useRef, useState } from "react"
import { Download, Share, X } from "lucide-react"
import { Button } from "@/components/ui/button"

type InstallMode = "android" | "ios" | null

export function PwaInstallButton() {
    const [mode, setMode] = useState<InstallMode>(null)
    const [showIOSGuide, setShowIOSGuide] = useState(false)
    const deferredPrompt = useRef<Event & { prompt: () => Promise<void> } | null>(null)

    useEffect(() => {
        if (typeof window === "undefined") return

        // Already installed — don't show button
        const isStandalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            (navigator as Navigator & { standalone?: boolean }).standalone === true
        if (isStandalone) return

        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
        if (isIOS) {
            // Only show in Safari; Chrome/Firefox on iOS can't install PWAs
            const isSafari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent)
            if (isSafari) setMode("ios")
            return
        }

        // Check if the event was already captured by the inline <head> script
        const w = window as Window & { __deferredInstallPrompt?: Event & { prompt: () => Promise<void> } }
        if (w.__deferredInstallPrompt) {
            deferredPrompt.current = w.__deferredInstallPrompt
            setMode("android")
            return
        }

        // Listen for future events (fires after this component mounts) and for
        // the synthetic event dispatched by the inline script on slow hydration
        const handler = (e: Event) => {
            if (e.type === "beforeinstallprompt") e.preventDefault()
            const prompt = e.type === "pwaInstallReady" ? w.__deferredInstallPrompt : e as Event & { prompt: () => Promise<void> }
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

    if (!mode) return null

    if (mode === "ios") {
        return (
            <div className="relative">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 md:h-10 md:w-10"
                    title="Install App"
                    onClick={() => setShowIOSGuide(true)}
                >
                    <Download className="w-4 h-4 md:w-5 md:h-5" />
                </Button>

                {showIOSGuide && (
                    <div className="absolute right-0 top-12 z-50 w-64 rounded-xl border border-border bg-card p-4 shadow-xl dark:border-border dark:bg-card">
                        <button
                            className="absolute right-2 top-2 text-muted-foreground hover:text-muted-foreground"
                            onClick={() => setShowIOSGuide(false)}
                        >
                            <X className="h-4 w-4" />
                        </button>
                        <p className="mb-2 text-sm font-semibold text-foreground dark:text-gray-100">
                            Install DATAGOD
                        </p>
                        <ol className="space-y-2 text-xs text-muted-foreground dark:text-muted-foreground">
                            <li className="flex items-start gap-2">
                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-[10px]">1</span>
                                <span>
                                    Tap the{" "}
                                    <Share className="inline h-3.5 w-3.5 text-primary" />{" "}
                                    <strong>Share</strong> button in Safari&apos;s toolbar
                                </span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-[10px]">2</span>
                                <span>
                                    Scroll down and tap <strong>Add to Home Screen</strong>
                                </span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-[10px]">3</span>
                                <span>Tap <strong>Add</strong> — DATAGOD will appear on your home screen</span>
                            </li>
                        </ol>
                    </div>
                )}
            </div>
        )
    }

    // Android / Chrome path — browser-native install prompt
    return (
        <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 md:h-10 md:w-10"
            title="Install App"
            onClick={async () => {
                if (!deferredPrompt.current) return
                await deferredPrompt.current.prompt()
                deferredPrompt.current = null
                setMode(null)
            }}
        >
            <Download className="w-4 h-4 md:w-5 md:h-5" />
        </Button>
    )
}
