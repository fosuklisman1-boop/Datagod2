'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const buffer: ArrayBuffer = new ArrayBuffer(rawData.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i)
  }
  return output
}

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
      // Get the authenticated user ID — we need it to link the subscription
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return

      const registration = await navigator.serviceWorker.ready

      const existing = await registration.pushManager.getSubscription()

      if (Notification.permission === 'granted') {
        if (!existing) await subscribeToPush(registration, user.id)
        return
      }

      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission()
        if (permission === 'granted' && !cancelled) {
          await subscribeToPush(registration, user.id)
        }
      }

      // 'denied' — user blocked; nothing to do
    }

    setup().catch((err) => console.warn('[Push] Setup error:', err))

    return () => { cancelled = true }
  }, [])

  return null
}
