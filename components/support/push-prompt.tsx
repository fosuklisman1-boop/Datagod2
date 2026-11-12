"use client"

import { useEffect, useState } from "react"
import { Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabase"
import { urlBase64ToUint8Array } from "@/lib/vapid-utils"
import { isPushAvailable } from "@/lib/pwa-utils"

/** Inline prompt shown while chatting without notifications. Mirrors the subscribe steps of PushOptInBanner. */
export function PushPrompt() {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setShow(isPushAvailable() && Notification.permission === "default")
  }, [])

  if (!show) return null

  const enable = async () => {
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission === "granted") {
        const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
        if (vapidKey) {
          const registration = await navigator.serviceWorker.ready
          const existing = await registration.pushManager.getSubscription()
          if (!existing) {
            const { data } = await supabase.auth.getUser()
            if (data.user) {
              const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey),
              })
              await fetch("/api/push/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subscription, userId: data.user.id }),
              })
            }
          }
        }
      }
    } catch (err) {
      console.warn("[support] push enable failed:", err)
    } finally {
      setBusy(false)
      setShow(false)
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-primary/5 px-4 py-2.5">
      <Bell className="h-4 w-4 shrink-0 text-primary" />
      <p className="flex-1 text-xs text-foreground">Turn on notifications to know when support replies.</p>
      <Button size="sm" onClick={enable} disabled={busy}>
        {busy ? "Enabling..." : "Enable"}
      </Button>
    </div>
  )
}
