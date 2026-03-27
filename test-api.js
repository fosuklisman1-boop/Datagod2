const API_KEY = 'dg_live_4cb6cffe4c571a3bd9555ec5843f36ecc783bcb45c7939f7e8407fe9f8f22f6f';
const BASE_URL = 'https://www.datagod.store';

async function runTests() {
  console.log('--- STARTING PROGRAMMATIC API TESTS ---');
  const reference = 'TEST-' + Date.now();
  
  // 1. Place Order
  console.log(`\n[1/2] Placing order (Ref: ${reference})...`);
  const postRes = await fetch(`${BASE_URL}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': API_KEY
    },
    body: JSON.stringify({
      network: 'mtn',
      recipient: '0555773910', // Changed from 'number'
      volume_gb: 1,            // Changed from 'gb'
      reference: reference
    })
  });
  
  const postData = await postRes.json();
  console.log('Response:', JSON.stringify(postData, null, 2));

  if (!postData.success) {
    console.error('Placement failed. Stopping.');
    return;
  }

  // 2. Check Status
  console.log(`\n[2/2] Checking status for reference: ${reference}...`);
  const getRes = await fetch(`${BASE_URL}/api/v1/orders?reference=${reference}`, {
    headers: { 'X-API-KEY': API_KEY }
  });
  const getData = await getRes.json();
  console.log('Response:', JSON.stringify(getData, null, 2));
}

runTests().catch(err => console.error('Test Error:', err));
