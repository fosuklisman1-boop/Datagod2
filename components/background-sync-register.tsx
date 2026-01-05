'use client';

import { useEffect } from 'react';

export function BackgroundSyncRegister() {
  useEffect(() => {
    // Register background sync if supported
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then(async (registration) => {
        try {
          await registration.sync.register('sync-failed-requests');
          console.log('[Background Sync] Registered: sync-failed-requests');
        } catch (error) {
          console.log('[Background Sync] Registration failed:', error);
        }
      });
    }
  }, []);

  return null;
}
