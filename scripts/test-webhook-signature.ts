import crypto from 'crypto'

function testWebhookSignature() {
  const secret = process.env.MTN_WEBHOOK_SECRET
