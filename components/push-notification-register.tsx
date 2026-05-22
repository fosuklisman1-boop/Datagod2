'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { urlBase64ToUint8Array } from '@/lib/vapid-utils'

async function subscribeToPush(registration: ServiceWorkerRegistration, userId: string) {
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!vapidKey) {
    console.warn('[Push] NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set')
    return
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  })

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, userId }),
  })
}

export function PushNotificationRegister() {
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      return
    }

    let cancelled = false

    const setup = async () => {
      // Only auto-subscribe if the user already granted permission (returning subscriber)
      // New users see the opt-in prompt inside NotificationCenter instead
      if (Notification.permission !== 'granted') return

      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return

      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      if (!existing) await subscribeToPush(registration, user.id)
    }

    setup().catch((err) => console.warn('[Push] Setup error:', err))

    return () => { cancelled = true }
  }, [])

  return null
}
