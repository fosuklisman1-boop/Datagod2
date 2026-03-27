const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { count: keys, error: kErr } = await supabase.from('user_api_keys').select('*', { count: 'exact', head: true });
  const { count: logs, error: lErr } = await supabase.from('user_api_logs').select('*', { count: 'exact', head: true });
  
  console.log('--- DB SUMMARY ---');
  console.log('API Keys count:', keys);
  if (kErr) console.error('Keys Error:', kErr);
  
  console.log('API Logs count:', logs);
  if (lErr) console.error('Logs Error:', lErr);
}

check();
