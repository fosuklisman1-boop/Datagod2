import webpush from 'web-push'
import { supabaseAdmin } from './supabase'

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'admin@datagod.com'}`,
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
)

export interface PushPayload {
  title: string
  body: string
  icon?: string
  badge?: string
  data?: Record<string, unknown>
}

interface StoredSubscription {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

async function getSubscriptionsForUser(userId: string): Promise<StoredSubscription[]> {
  const { data, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId)

  if (error) {
    console.error('[PushService] Failed to fetch subscriptions for user:', error)
    return []
  }
  return data || []
}

async function removeSubscription(endpoint: string) {
  await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
}

async function sendToSubscriptions(
  subscriptions: StoredSubscription[],
  payload: PushPayload
): Promise<{ sent: number; removed: number }> {
  const payloadStr = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || '/icons/icon-192x192.png',
    badge: payload.badge || '/icons/icon-192x192.png',
    data: payload.data || {},
  })

  let sent = 0
  let removed = 0

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr
        )
        sent++
      } catch (err: any) {
        // 410 Gone = subscription expired/revoked — clean it up
        if (err.statusCode === 410 || err.statusCode === 404) {
          await removeSubscription(sub.endpoint)
          removed++
        } else {
          console.error('[PushService] Send error for endpoint:', sub.endpoint, err.message)
        }
      }
    })
  )

  return { sent, removed }
}

/** Send a push notification to a specific user (all their devices). */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; removed: number }> {
  const subscriptions = await getSubscriptionsForUser(userId)
  if (!subscriptions.length) return { sent: 0, removed: 0 }
  return sendToSubscriptions(subscriptions, payload)
}

/** Broadcast a push notification to all subscribed users. */
export async function broadcastPush(
  payload: PushPayload
): Promise<{ sent: number; removed: number }> {
  const { data, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('*')

  if (error || !data?.length) return { sent: 0, removed: 0 }
  return sendToSubscriptions(data, payload)
}

/** Send a push notification to all admin users (role = 'admin'). */
export async function notifyAdminsPush(
  payload: PushPayload
): Promise<{ sent: number; removed: number }> {
  const { data: admins, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'admin')

  if (error || !admins?.length) return { sent: 0, removed: 0 }

  const results = await Promise.all(admins.map((a) => sendPushToUser(a.id, payload)))
  return results.reduce(
    (acc, r) => ({ sent: acc.sent + r.sent, removed: acc.removed + r.removed }),
    { sent: 0, removed: 0 }
  )
}
