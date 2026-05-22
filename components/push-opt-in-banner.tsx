'use client'

import { useEffect, useState } from 'react'
import { Bell, X, Sparkles } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { urlBase64ToUint8Array } from '@/lib/vapid-utils'

export function PushOptInBanner() {
  const [visible, setVisible] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) return

    if (Notification.permission === 'default') {
      // Small delay so it doesn't flash instantly on load
      const t = setTimeout(() => setVisible(true), 1500)
      return () => clearTimeout(t)
    }
  }, [])

  const handleEnable = async () => {
    setEnabling(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
        if (vapidKey) {
          const registration = await navigator.serviceWorker.ready
          const existing = await registration.pushManager.getSubscription()
          if (!existing) {
            const { data: { user } } = await supabase.auth.getUser()
            if (user) {
              const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey),
              })
              await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription, userId: user.id }),
              })
            }
          }
        }
      }
    } catch (err) {
      console.warn('[PushBanner] enable failed:', err)
    } finally {
      setEnabling(false)
      setVisible(false)
    }
  }

  const handleDismiss = () => {
    setDismissed(true)
    setVisible(false)
  }

  if (!visible || dismissed) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md animate-in slide-in-from-bottom-4 duration-300">
      <div className="relative flex items-start gap-4 bg-white border border-violet-200 rounded-2xl shadow-xl px-5 py-4">
        {/* Dismiss */}
        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Icon */}
        <div className="shrink-0 mt-0.5 w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center">
          <Bell className="w-5 h-5 text-violet-600" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pr-4">
          <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
            Stay in the loop
            <Sparkles className="w-3.5 h-3.5 text-violet-500" />
          </p>
          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
            Get instant alerts for order updates, withdrawals, and payments — even when the app is closed.
          </p>

          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleEnable}
              disabled={enabling}
              className="flex-1 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl transition-colors disabled:opacity-60"
            >
              {enabling ? 'Enabling…' : 'Enable notifications'}
            </button>
            <button
              onClick={handleDismiss}
              className="text-sm text-gray-400 hover:text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
