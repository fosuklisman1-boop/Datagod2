'use client';

import { useEffect, useState } from 'react';

export function PushNotificationRegister() {
  const [isSupported, setIsSupported] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);

  useEffect(() => {
    // Check if push notifications are supported
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    setIsSupported(supported);

    if (supported) {
      navigator.serviceWorker.ready.then(async (registration) => {
        try {
          // Check if already subscribed
          const subscription = await registration.pushManager.getSubscription();
          setIsSubscribed(!!subscription);

          // Request notification permission
          if (Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
              await subscribeToPush(registration);
            }
          } else if (Notification.permission === 'granted' && !subscription) {
            await subscribeToPush(registration);
          }
        } catch (error) {
          console.log('[Push Notifications] Setup error:', error);
        }
      });
    }
  }, []);

  const subscribeToPush = async (registration: ServiceWorkerRegistration) => {
    try {
      // Generate a VAPID key for your server
      // For now, using a placeholder - replace with your actual VAPID key
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
          'BKlzIREJUg3PfRtOLUHaCpbLLmAhJrKBkKdVkMvdJL9ZLxxgS7L7zK1K8Z3L7LmPL7L7L7L7L7L7L7L7L7L7L7L7L'
        ),
      });

      // Save subscription to server
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });

      setIsSubscribed(true);
      console.log('[Push Notifications] Subscribed successfully');
    } catch (error) {
      console.log('[Push Notifications] Subscription failed:', error);
    }
  };

  // Helper function to convert VAPID key
  const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  };

  return null;
}
