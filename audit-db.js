const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  console.log('--- DATABASE AUDIT ---');
  
  const { data: orders, error: oError } = await supabase
    .from('api_orders')
    .select('id, user_id, network, volume_gb, price, status, created_at')
    .order('created_at', { ascending: false })
    .limit(2);
    
  if (oError) console.error('Order Error:', oError);
  else console.log('Recent API Orders:', JSON.stringify(orders, null, 2));

  const { data: txs, error: tError } = await supabase
    .from('transactions')
    .select('id, user_id, type, source, amount, description, created_at')
    .eq('source', 'api_order')
    .order('created_at', { ascending: false })
    .limit(2);

  if (tError) console.error('Transaction Error:', tError);
  else console.log('Recent API Transactions:', JSON.stringify(txs, null, 2));
}

check().catch(err => console.error(err));
