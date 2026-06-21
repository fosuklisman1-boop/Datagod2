'use client'

import { useEffect, useState } from 'react'
import { Bell, X, Sparkles, Share, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { urlBase64ToUint8Array } from '@/lib/vapid-utils'
import { isIOS, isStandalone, isPushAvailable } from '@/lib/pwa-utils'

type BannerMode = 'push' | 'ios-install' | null

export function PushOptInBanner() {
  const [mounted, setMounted] = useState(false)
  const [mode, setMode] = useState<BannerMode>(null)
  const [show, setShow] = useState(false)
  const [enabling, setEnabling] = useState(false)

  useEffect(() => {
    setMounted(true)

    // Already decided — nothing to show
    if ('Notification' in window && Notification.permission !== 'default') return

    if (isIOS() && !isStandalone()) {
      // iOS Safari: can't subscribe yet, prompt to install
      setMode('ios-install')
      setTimeout(() => setShow(true), 1200)
    } else if (isPushAvailable()) {
      // All other supported contexts (Chrome, Firefox, installed PWA on iOS)
      setMode('push')
      setTimeout(() => setShow(true), 1200)
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
      setShow(false)
    }
  }

  if (!mounted || mode === null) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1rem',
        left: '50%',
        transform: `translateX(-50%) translateY(${show ? '0' : '120%'})`,
        transition: 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
        zIndex: 9999,
        width: 'min(calc(100vw - 2rem), 440px)',
      }}
      aria-live="polite"
    >
      <div className="relative flex items-start gap-4 bg-card border border-border rounded-2xl shadow-2xl px-5 py-4">
        <button
          onClick={() => setShow(false)}
          className="absolute top-3 right-3 p-1 text-muted-foreground hover:text-muted-foreground rounded-full hover:bg-accent transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="shrink-0 mt-0.5 w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
          <Bell className="w-5 h-5 text-primary" />
        </div>

        {mode === 'push' ? (
          <div className="flex-1 min-w-0 pr-5">
            <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              Stay in the loop
              <Sparkles className="w-3.5 h-3.5 text-primary" />
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              Get instant alerts for order updates, withdrawals, and payments — even when the app is closed.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={handleEnable}
                disabled={enabling}
                className="flex-1 text-sm font-semibold bg-primary hover:bg-primary/90 active:bg-primary/80 text-primary-foreground px-4 py-2 rounded-xl transition-colors disabled:opacity-60"
              >
                {enabling ? 'Enabling…' : 'Enable notifications'}
              </button>
              <button
                onClick={() => setShow(false)}
                className="text-sm text-muted-foreground hover:text-muted-foreground px-3 py-2 rounded-xl hover:bg-accent transition-colors"
              >
                Not now
              </button>
            </div>
          </div>
        ) : (
          // iOS Safari — prompt to install PWA first
          <div className="flex-1 min-w-0 pr-5">
            <p className="text-sm font-semibold text-foreground">Add to Home Screen</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              To receive push notifications on iPhone, install this app first:
            </p>
            <ol className="mt-2 space-y-1">
              <li className="flex items-center gap-2 text-xs text-muted-foreground">
                <Share className="w-3.5 h-3.5 text-primary shrink-0" />
                Tap the <span className="font-semibold">Share</span> button in Safari
              </li>
              <li className="flex items-center gap-2 text-xs text-muted-foreground">
                <Plus className="w-3.5 h-3.5 text-primary shrink-0" />
                Select <span className="font-semibold">Add to Home Screen</span>
              </li>
              <li className="flex items-center gap-2 text-xs text-muted-foreground">
                <Bell className="w-3.5 h-3.5 text-primary shrink-0" />
                Open the app and enable notifications
              </li>
            </ol>
            <button
              onClick={() => setShow(false)}
              className="mt-3 text-xs text-muted-foreground hover:text-muted-foreground"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
