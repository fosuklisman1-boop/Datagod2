
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function dumpLogs() {
  console.log('Fetching recent SMS logs...');
  const { data, error } = await supabase
    .from('sms_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error fetching logs:', error);
    return;
  }

  console.log('Recent Logs:', JSON.stringify(data, null, 2));
}

dumpLogs();
