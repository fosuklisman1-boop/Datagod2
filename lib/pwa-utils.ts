/** Returns true on iPhone / iPad regardless of display mode. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPad on iOS 13+ reports itself as MacIntel with touch points
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Returns true when the app is running as an installed PWA (standalone). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari-specific
    ('standalone' in window.navigator && (window.navigator as any).standalone === true)
  )
}

/** Returns true when push notifications are usable in the current context. */
export function isPushAvailable(): boolean {
  if (typeof window === 'undefined') return false
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return false
  // On iOS, push only works inside an installed PWA
  if (isIOS() && !isStandalone()) return false
  return true
}
