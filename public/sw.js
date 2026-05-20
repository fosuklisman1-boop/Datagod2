// DATAGOD Service Worker — v2
// Vanilla (no CDN deps), versioned caches, fintech-safe caching rules

const CACHE_VERSION = 'v2'
const STATIC_CACHE = `datagod-static-${CACHE_VERSION}`
const PAGES_CACHE  = `datagod-pages-${CACHE_VERSION}`
const ALL_CACHES   = [STATIC_CACHE, PAGES_CACHE]

const PRECACHE_ASSETS = [
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
]

// These paths handle money/auth — never serve from cache
const NEVER_CACHE = [
  /^\/api\/payments\//,
  /^\/api\/wallet\//,
  /^\/api\/orders\/purchase/,
  /^\/api\/admin\//,
  /^\/api\/user\//,
  /^\/api\/push\//,
  /^\/api\/afa\//,
  /^\/api\/airtime\/purchase/,
  /^\/api\/results-checker\/purchase/,
  /^\/api\/shop\/orders\/create/,
]

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS))
  )
})

// ── Activate — delete old caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(names.filter((n) => !ALL_CACHES.includes(n)).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  )
})

// ── Message ──────────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Skip cross-origin (Paystack, Supabase, fonts, etc.)
  if (url.origin !== location.origin) return

  // Never intercept non-GET requests (POST = payment/order mutations)
  if (request.method !== 'GET') return

  // Never cache financial or auth endpoints
  if (NEVER_CACHE.some((p) => p.test(url.pathname))) return

  // Navigation — network-first, offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone()
          caches.open(PAGES_CACHE).then((c) => c.put(request, clone))
          return res
        })
        .catch(async () => {
          const cached = await caches.match(request)
          if (cached) return cached
          return caches.match('/offline.html')
        })
    )
    return
  }

  // Static assets (JS, CSS, fonts, images) — cache-first
  const isStatic = /\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|ico|webp|avif)(\?|$)/.test(url.pathname)
  if (isStatic) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((res) => {
          if (res.status === 200) {
            caches.open(STATIC_CACHE).then((c) => c.put(request, res.clone()))
          }
          return res
        })
      })
    )
    return
  }

  // All other GET requests (safe API reads) — network-first, no caching
  // Let the browser handle these directly to ensure live data
})

// ── Push Notifications ───────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return

  let title = 'DATAGOD'
  const options = {
    body: 'You have a new notification.',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    vibrate: [200, 100, 200],
    tag: 'datagod-notification',
    requireInteraction: false,
    data: {},
  }

  try {
    const payload = JSON.parse(event.data.text())
    title = payload.title || title
    options.body = payload.body || options.body
    options.data = payload.data || {}
    if (payload.tag) options.tag = payload.tag
    if (payload.requireInteraction) options.requireInteraction = payload.requireInteraction
  } catch {
    options.body = event.data.text()
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const urlToOpen = event.notification.data?.url || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(urlToOpen) && 'focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow(urlToOpen)
    })
  )
})

// ── Background Sync — retry failed requests ──────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-failed-requests') {
    event.waitUntil(retryFailedRequests())
  }
})

async function retryFailedRequests() {
  try {
    const db = await openDB()
    const requests = await getAllFromStore(db, 'failed-requests')
    for (const req of requests) {
      try {
        const res = await fetch(req.url, { method: req.method, body: req.body, headers: req.headers })
        if (res.ok) await deleteFromStore(db, 'failed-requests', req.id)
      } catch { /* retry next sync cycle */ }
    }
  } catch (err) {
    console.log('[SW] Background sync error:', err)
  }
}

// ── IndexedDB helpers ────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('datagod-sync', 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('failed-requests')) {
        db.createObjectStore('failed-requests', { keyPath: 'id', autoIncrement: true })
      }
    }
  })
}

function getAllFromStore(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store])
    const req = tx.objectStore(store).getAll()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
  })
}

function deleteFromStore(db, store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], 'readwrite')
    const req = tx.objectStore(store).delete(id)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}
