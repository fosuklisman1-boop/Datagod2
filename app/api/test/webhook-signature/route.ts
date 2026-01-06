import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get('x-webhook-signature')
    const secret = process.env.MTN_WEBHOOK_SECRET || 'test_secret'

    if (!signature) {
      return NextResponse.json(
        { error: 'Missing webhook signature', success: false },
        { status: 401 }
      )
    }

    const body = await request.text()
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')

    const isValid = signature === expectedSignature

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid webhook signature', success: false },
        { status: 401 }
      )
    }

    const payload = JSON.parse(body)
    return NextResponse.json({
      success: true,
      message: 'Webhook processed',
      order_id: payload.order_id,
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed', success: false },
      { status: 500 }
    )
  }
}
