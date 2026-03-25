const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing env vars. Please ensure they are set.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

async function check() {
  console.log("Checking latest wallet_payments...");
  const { data: payments, error: pError } = await supabase
    .from('wallet_payments')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  
  if (pError) console.error("Payments Error:", pError);
  else console.table(payments.map(p => ({ 
    id: p.id, 
    order_id: p.order_id, 
    order_type: p.order_type, 
    status: p.status, 
    ref: p.reference,
    created: p.created_at
  })));

  console.log("\nChecking latest airtime_orders...");
  const { data: airtime, error: aError } = await supabase
    .from('airtime_orders')
    .select('id, status, payment_status, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (aError) console.error("Airtime Error:", aError);
  else console.table(airtime);
}

check();
