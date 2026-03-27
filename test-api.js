const key = "dg_live_4cb6cffe4c571a3bd9555ec5843f36ecc783bcb45c7939f7e8407fe9f8f22f6f";
const baseUrl = "https://www.datagod.store/api/v1";

const fs = require('fs');

async function runTests() {
  const results = {};
  
  // 1. BALANCE GET
  console.log("Testing GET /balance...");
  try {
    const res = await fetch(`${baseUrl}/balance`, { headers: { "X-API-Key": key } });
    const json = await res.json();
    results.balance = { status: res.status, data: json };
  } catch (e) {
    results.balance = { error: e.message };
  }

  // 2. ORDERS POST
  const ref = "DG-" + Math.random().toString(36).substring(7).toUpperCase();
  console.log(`Testing POST /orders (MTN, 1GB) with reference: ${ref}...`);
  try {
    const res = await fetch(`${baseUrl}/orders`, { 
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        network: "MTN",
        volume_gb: 1,
        recipient: "0555773910",
        reference: ref
      })
    });
    const json = await res.json();
    results.order_post = { status: res.status, data: json };

    // 3. ORDERS GET
    if (res.status === 201 || res.status === 200) {
      console.log(`Testing GET /orders for reference: ${ref}...`);
      const res2 = await fetch(`${baseUrl}/orders?reference=${ref}`, { headers: { "X-API-Key": key } });
      results.order_get = { status: res2.status, data: await res2.json() };
    }

  } catch (e) {
    results.order_post = { error: e.message };
  }

  fs.writeFileSync('results.json', JSON.stringify(results, null, 2), 'utf8');
  console.log("Tests complete. Results saved to results.json");
}

runTests();
