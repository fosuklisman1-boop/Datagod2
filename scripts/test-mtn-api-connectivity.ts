// Native fetch is available in Next.js 15

async function testMTNConnectivity() {
  const apiKey = process.env.MTN_API_KEY
  const baseUrl = process.env.MTN_API_BASE_URL

  console.log('🧪 Testing MTN API Connectivity')
  console.log(`   Base URL: ${baseUrl}`)
  console.log(`   API Key: ${apiKey?.substring(0, 10)}...`)

  try {
    // Test 1: Basic connectivity
    const response = await fetch(`${baseUrl}/health`, {
      headers: { 'X-API-KEY': apiKey } as Record<string, string>
    })

    console.log(`✅ Health Check: ${response.status}`)

    // Test 2: Authentication
    const authTest = await fetch(`${baseUrl}/orders`, {
      method: 'GET',
      headers: { 'X-API-KEY': apiKey } as Record<string, string>
    })

    console.log(`✅ Authentication: ${authTest.status}`)

    // Test 3: Check balance
    const balanceTest = await fetch(`${baseUrl}/balance`, {
      method: 'GET',
      headers: { 'X-API-KEY': apiKey } as Record<string, string>
    })

    const balance = await balanceTest.json()
    console.log(`✅ Balance: ${balance.amount} ${balance.currency}`)

    console.log('\n✅ All connectivity tests passed!')
  } catch (error: any) {
    console.error('❌ Connectivity test failed:')
    console.error(error)
    process.exit(1)
  }
}

testMTNConnectivity()
