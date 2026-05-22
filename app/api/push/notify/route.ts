import { NextResponse } from 'next/server'
import { sendPushToUser, broadcastPush, type PushPayload } from '@/lib/push-service'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const { title, body, icon, data, userId } = await request.json()

    if (!title || !body) {
      return NextResponse.json({ error: 'title and body are required' }, { status: 400 })
    }

    const payload: PushPayload = {
      title,
      body,
      icon: icon || '/icons/icon-192x192.png',
      data: data || {},
    }

    const result = userId
      ? await sendPushToUser(userId, payload)
      : await broadcastPush(payload)

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('[Push] Notify error:', error)
    return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 })
  }
}
