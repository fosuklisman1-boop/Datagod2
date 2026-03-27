const key = "dg_live_your_actual_key_here";
const baseUrl = "https://www.datagod.store/api/v1";

const fs = require('fs');

async function runTests() {
  const results = {};
  
  // 1. BALANCE GET
  try {
    const res = await fetch(`${baseUrl}/balance`, { headers: { "X-API-Key": key } });
    results.balance = { status: res.status, data: await res.json() };
  } catch (e) {
    results.balance = { error: e.message };
  }

  // 2. ORDERS POST
  const ref = "TEST-" + Math.random().toString(36).substring(7).toUpperCase();
  try {
    const res = await fetch(`${baseUrl}/orders`, { 
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        network: "MTN",
        number: "0555773910",
        volume_gb: 1,
        recipient: "0555773910",
        reference: ref
      })
    });
    results.order_post = { status: res.status, data: await res.json() };

    // 3. ORDERS GET
    const res2 = await fetch(`${baseUrl}/orders?reference=${ref}`, { headers: { "X-API-Key": key } });
    results.order_get = { status: res2.status, data: await res2.json() };

  } catch (e) {
    results.order_post = { error: e.message };
  }

  fs.writeFileSync('results.json', JSON.stringify(results, null, 2), 'utf8');
  console.log("Done");
}

runTests();
