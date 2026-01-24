import crypto from 'crypto'

function testWebhookSignature() {
  const secret = process.env.MTN_WEBHOOK_SECRET || 'test_secret'
  const payload = JSON.stringify({ event: 'order.status_changed', order: { id: 123, status: 'completed' } })
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  console.log('Payload:', payload)
  console.log('Secret:', secret)
  console.log('Signature:', signature)
}

testWebhookSignature()
