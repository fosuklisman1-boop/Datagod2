// This is the "Offline page" service worker

importScripts('https://storage.googleapis.com/workbox-cdn/releases/5.1.2/workbox-sw.js');

const CACHE = "pwabuilder-page";
const OFFLINE_CACHE = "pwabuilder-offline";

const offlineFallbackPage = "offline.html";

// Assets to cache for offline support
const assetsToCache = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/favicon.ico',
];

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener('install', async (event) => {
  event.waitUntil(
    Promise.all([
      // Cache offline page
      caches.open(CACHE)
        .then((cache) => cache.add(offlineFallbackPage)),
      // Cache offline assets
      caches.open(OFFLINE_CACHE)
        .then((cache) => cache.addAll(assetsToCache))
    ])
  );
  self.skipWaiting();
});

// Clean up old caches on activation
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE && name !== OFFLINE_CACHE) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

if (workbox.navigationPreload.isSupported()) {
  workbox.navigationPreload.enable();
}

// Periodic sync event: fetch app data in the background
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'sync-app-data') {
    event.waitUntil(
      fetch('/api/periodic/sync')
        .then((response) => {
          if (response.ok) {
            return response.json();
          }
        })
        .catch((error) => {
          console.log('[SW] Periodic sync failed:', error);
        })
    );
  }
});

// Background Sync: Retry failed requests when connection is restored
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-failed-requests') {
    event.waitUntil(
      (async () => {
        try {
          const db = await openIndexedDB();
          const failedRequests = await getFailedRequests(db);
          
          for (const request of failedRequests) {
            try {
              const response = await fetch(request.url, {
                method: request.method,
                body: request.body,
                headers: request.headers,
              });
              
              if (response.ok) {
                await removeFailedRequest(db, request.id);
              }
            } catch (error) {
              console.log('[SW] Failed to retry request:', error);
            }
          }
        } catch (error) {
          console.log('[SW] Background sync error:', error);
        }
      })()
    );
  }
});

// Push Notifications
self.addEventListener('push', (event) => {
  if (event.data) {
    const options = {
      body: event.data.text(),
      icon: '/favicon-96x96.png',
      badge: '/favicon-96x96.png',
      vibrate: [200, 100, 200],
      tag: 'datagod-notification',
      requireInteraction: false,
    };

    try {
      const data = JSON.parse(event.data.text());
      options.body = data.body || options.body;
      options.title = data.title || 'DATAGOD';
      options.data = data.data || {};
    } catch (e) {
      options.title = 'DATAGOD';
    }

    event.waitUntil(
      self.registration.showNotification(options.title || 'DATAGOD', options)
    );
  }
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Check if app is already open
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].url === urlToOpen && 'focus' in clientList[i]) {
            return clientList[i].focus();
          }
        }
        // Open new window if not already open
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// Offline support: Enhanced fetch strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Navigation requests
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preloadResp = await event.preloadResponse;

        if (preloadResp) {
          return preloadResp;
        }

        const networkResp = await fetch(event.request);
        return networkResp;
      } catch (error) {
        // Serve offline page on network error
        const cache = await caches.open(OFFLINE_CACHE);
        const cachedResp = await cache.match(offlineFallbackPage);
        return cachedResp;
      }
    })());
    return;
  }

  // Non-navigation requests
  // API calls: network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch((error) => {
          return caches.match(request)
            .then((cached) => cached || new Response('Offline', { status: 503 }));
        })
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request)
      .then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(request).then((response) => {
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(OFFLINE_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        });
      })
      .catch(() => {
        return caches.match('/offline.html');
      })
  );
});

// IndexedDB helpers for background sync
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('datagod-sync', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('failed-requests')) {
        db.createObjectStore('failed-requests', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

function getFailedRequests(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['failed-requests']);
    const store = transaction.objectStore('failed-requests');
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function removeFailedRequest(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['failed-requests'], 'readwrite');
    const store = transaction.objectStore('failed-requests');
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
