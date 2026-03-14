import crypto from 'crypto'

// Test MTN phone validation and network detection
async function testPhoneValidation() {
  console.log('\n🧪 Testing Phone Validation & Network Detection\n')

  const testCases = [
    { phone: '0541234567', expectedNetwork: 'MTN', description: 'Ghana format' },
    { phone: '541234567', expectedNetwork: 'MTN', description: 'No leading 0' },
    { phone: '233541234567', expectedNetwork: 'MTN', description: 'Country code' },
    { phone: '0551234567', expectedNetwork: 'Telecel', description: 'Telecel network' },
    { phone: '0571234567', expectedNetwork: 'AirtelTigo', description: 'AT network' },
    { phone: '123', expectedNetwork: null, description: 'Invalid format' },
  ]

  for (const testCase of testCases) {
    try {
      const response = await fetch('http://localhost:3000/api/test/validate-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testCase.phone })
      })

      const result = await response.json()

      if (testCase.expectedNetwork === null) {
        if (!result.valid) {
          console.log(`✅ ${testCase.description} (${testCase.phone}): Correctly rejected`)
        } else {
          console.log(`❌ ${testCase.description} (${testCase.phone}): Should be invalid but passed`)
        }
      } else {
        if (result.valid && result.network === testCase.expectedNetwork) {
          console.log(`✅ ${testCase.description} (${testCase.phone}): ${result.network}`)
        } else {
          console.log(`❌ ${testCase.description} (${testCase.phone}): Expected ${testCase.expectedNetwork}, got ${result.network}`)
        }
      }
    } catch (error: any) {
      console.log(`❌ ${testCase.description}: ${error.message}`)
    }
  }
}

// Test webhook signature validation
async function testWebhookSignature() {
  console.log('\n🧪 Testing Webhook Signature Validation\n')

  const secret = process.env.MTN_WEBHOOK_SECRET || 'test_secret'
  const payload = JSON.stringify({
    order_id: 'TEST-001',
    status: 'completed',
    timestamp: Date.now()
  })

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  try {
    const response = await fetch('http://localhost:3000/api/webhook/mtn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature
      },
      body: payload
    })

    if (response.status === 200) {
      console.log('✅ Valid webhook signature accepted')
    } else {
      console.log(`❌ Valid signature rejected: ${response.status}`)
    }
  } catch (error: any) {
    console.log(`❌ Webhook test failed: ${error.message}`)
  }

  // Test invalid signature
  try {
    const response = await fetch('http://localhost:3000/api/webhook/mtn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': 'invalid_signature'
      },
      body: payload
    })

    if (response.status === 401) {
      console.log('✅ Invalid webhook signature rejected')
    } else {
      console.log(`❌ Invalid signature should be rejected: ${response.status}`)
    }
  } catch (error: any) {
    console.log(`❌ Invalid signature test failed: ${error.message}`)
  }
}

// Test fulfillment router
async function testFulfillmentRouter() {
  console.log('\n🧪 Testing Fulfillment Router\n')

  const testOrder = {
    shop_order_id: 'TEST-ORD-' + Date.now(),
    network: 'MTN',
    phone_number: '0541234567',
    volume_gb: 1,
    customer_name: 'Test User'
  }

  try {
    const response = await fetch('http://localhost:3000/api/fulfillment/process-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testOrder)
    })

    const result = await response.json()

    if (response.ok) {
      console.log(`✅ Order routed successfully`)
      console.log(`   Method: ${result.fulfillment_method}`)
      console.log(`   Order: ${result.order_id}`)
      if (result.tracking_id) {
        console.log(`   Tracking: ${result.tracking_id}`)
      }
    } else {
      console.log(`❌ Router error: ${result.error}`)
    }
  } catch (error: any) {
    console.log(`❌ Router test failed: ${error.message}`)
  }
}

// Test admin endpoints
async function testAdminEndpoints() {
  console.log('\n🧪 Testing Admin Endpoints\n')

  // Get pending orders
  try {
    const response = await fetch('http://localhost:3000/api/admin/fulfillment/manual-fulfill', {
      method: 'GET'
    })

    const result = await response.json()

    if (response.ok) {
      console.log(`✅ Get pending orders: ${result.count} pending`)
      if (result.orders?.length > 0) {
        console.log(`   Orders in queue:`)
        result.orders.slice(0, 3).forEach((order: any) => {
          console.log(`   - ${order.id}: ${order.phone_number}`)
        })
      }
    } else {
      console.log(`❌ Failed to get pending orders: ${result.error}`)
    }
  } catch (error: any) {
    console.log(`❌ Get pending orders failed: ${error.message}`)
  }
}

// Test settings toggle
async function testSettingsToggle() {
  console.log('\n🧪 Testing Settings Toggle\n')

  try {
    // Get current setting
    const getResponse = await fetch('http://localhost:3000/api/admin/settings/mtn-auto-fulfillment')
    const currentSetting = await getResponse.json()

    console.log(`✅ Current auto-fulfillment: ${currentSetting.setting?.value ? 'ON' : 'OFF'}`)

    // Toggle setting
    const newValue = !currentSetting.setting?.value
    const updateResponse = await fetch('http://localhost:3000/api/admin/settings/mtn-auto-fulfillment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newValue })
    })

    const updated = await updateResponse.json()
    console.log(`✅ Toggled auto-fulfillment: ${updated.setting?.value ? 'ON' : 'OFF'}`)

    // Toggle back
    const resetResponse = await fetch('http://localhost:3000/api/admin/settings/mtn-auto-fulfillment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: currentSetting.setting?.value })
    })

    if (resetResponse.ok) {
      console.log(`✅ Reset to original state`)
    }
  } catch (error: any) {
    console.log(`❌ Settings toggle test failed: ${error.message}`)
  }
}

// Main test runner
async function runAllTests() {
  console.log('='.repeat(50))
  console.log('MTN INTEGRATION TESTS - PHASE 3')
  console.log('='.repeat(50))

  await testPhoneValidation()
  await testWebhookSignature()
  await testFulfillmentRouter()
  await testAdminEndpoints()
  await testSettingsToggle()

  console.log('\n' + '='.repeat(50))
  console.log('✅ Tests Complete')
  console.log('='.repeat(50))
}

// Run if executed directly
if (require.main === module) {
  runAllTests().catch(console.error)
}

export { testPhoneValidation, testWebhookSignature, testFulfillmentRouter, testAdminEndpoints, testSettingsToggle }
