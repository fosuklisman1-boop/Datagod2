/**
 * Diagnostic script to check fulfillment status
 * 
 * This script will:
 * 1. Query orders table to find AT-iShare orders
 * 2. Check fulfillment_logs for entries
 * 3. Verify which orders have been fulfilled
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
  console.error("❌ Missing environment variables:");
  console.error("  - NEXT_PUBLIC_SUPABASE_URL:", !!supabaseUrl);
  console.error("  - NEXT_PUBLIC_SUPABASE_ANON_KEY:", !!supabaseAnonKey);
  console.error("  - SUPABASE_SERVICE_ROLE_KEY:", !!supabaseServiceKey);
  process.exit(1);
}

const { createClient } = require("@supabase/supabase-js");

async function diagnose() {
  console.log("\n🔍 FULFILLMENT DIAGNOSTICS\n");

  // Use service role to bypass RLS
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // 1. Find AT-iShare orders
    console.log("1️⃣  Checking for AT-iShare orders...");
    const { data: atOrders, error: ordersError } = await supabase
      .from("orders")
      .select("id, network, size_gb, phone_number, created_at, status")
      .ilike("network", "%AT%")
      .order("created_at", { ascending: false })
      .limit(10);

    if (ordersError) {
      console.error("   ❌ Error fetching orders:", ordersError.message);
    } else if (!atOrders || atOrders.length === 0) {
      console.log("   ⚠️  No AT-iShare orders found");
    } else {
      console.log(`   ✅ Found ${atOrders.length} AT-iShare orders:\n`);
      atOrders.forEach((order, idx) => {
        console.log(`   ${idx + 1}. ID: ${order.id.substring(0, 8)}...`);
        console.log(`      Network: ${order.network}`);
        console.log(`      Phone: ${order.phone_number}`);
        console.log(`      Size: ${order.size_gb}GB`);
        console.log(`      Status: ${order.status}`);
        console.log(`      Created: ${new Date(order.created_at).toLocaleString()}\n`);
      });
    }

    // 2. Check fulfillment logs
    console.log("\n2️⃣  Checking fulfillment_logs table...");
    const { data: logs, error: logsError } = await supabase
      .from("fulfillment_logs")
      .select("id, order_id, network, phone_number, status, created_at, error_message")
      .order("created_at", { ascending: false })
      .limit(10);

    if (logsError) {
      console.error("   ❌ Error fetching logs:", logsError.message);
    } else if (!logs || logs.length === 0) {
      console.log("   ⚠️  No fulfillment logs found");
    } else {
      console.log(`   ✅ Found ${logs.length} fulfillment log entries:\n`);
      logs.forEach((log, idx) => {
        console.log(`   ${idx + 1}. Order: ${log.order_id.substring(0, 8)}...`);
        console.log(`      Network: ${log.network}`);
        console.log(`      Phone: ${log.phone_number}`);
        console.log(`      Status: ${log.status}`);
        console.log(`      Error: ${log.error_message || "None"}`);
        console.log(`      Created: ${new Date(log.created_at).toLocaleString()}\n`);
      });
    }

    // 3. Check for orders without fulfillment logs
    if (atOrders && atOrders.length > 0 && logs && logs.length > 0) {
      console.log("\n3️⃣  Checking which orders have been fulfilled...");
      const loggedOrderIds = new Set(logs.map((l) => l.order_id));
      const unfulfilledOrders = atOrders.filter((o) => !loggedOrderIds.has(o.id));

      if (unfulfilledOrders.length === 0) {
        console.log("   ✅ All AT-iShare orders have fulfillment logs!");
      } else {
        console.log(`   ⚠️  ${unfulfilledOrders.length} orders missing fulfillment logs:\n`);
        unfulfilledOrders.forEach((order, idx) => {
          console.log(`   ${idx + 1}. ID: ${order.id.substring(0, 8)}...`);
          console.log(`      Network: ${order.network}`);
          console.log(`      Created: ${new Date(order.created_at).toLocaleString()}\n`);
        });
      }
    }

    console.log("\n✅ Diagnostics complete!\n");
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

diagnose();
