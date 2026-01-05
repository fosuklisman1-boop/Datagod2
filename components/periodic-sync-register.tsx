'use client';

import { useEffect } from 'react';

export function PeriodicSyncRegister() {
  useEffect(() => {
    // Only register periodic sync if supported
    if ('serviceWorker' in navigator && 'periodicSync' in ServiceWorkerRegistration.prototype) {
      navigator.serviceWorker.ready.then(async (registration) => {
        try {
          // Register periodic sync to run every 24 hours (86400000 ms)
          // Note: Browsers may adjust this based on battery, connectivity, and user settings
          await registration.periodicSync.register('sync-app-data', {
            minInterval: 24 * 60 * 60 * 1000, // 24 hours
          });
          console.log('[Periodic Sync] Registered: sync-app-data');
        } catch (error) {
          console.log('[Periodic Sync] Registration failed:', error);
          // Periodic Sync API may not be supported or user permissions denied
        }
      });
    }
  }, []);

  return null;
}
