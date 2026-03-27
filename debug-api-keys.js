const { createClient } = require('@supabase/supabase-js');
const { config } = require('dotenv');

config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function debug() {
  console.log('--- Testing user_api_keys table directly ---');
  const { data: rawData, error: rawError } = await supabase
    .from('user_api_keys')
    .select('*');

  if (rawError) {
    console.error('Raw Fetch Error:', rawError);
  } else {
    console.log('Raw Count:', rawData.length);
    console.log('Raw Data sample:', rawData[0] ? { id: rawData[0].id, name: rawData[0].name } : 'EMPTY');
  }

  console.log('\n--- Testing with simplified join ---');
  const { data: joinedData, error: joinedError } = await supabase
    .from('user_api_keys')
    .select('*, user:user_id(*)');

  if (joinedError) {
    console.error('Joined Fetch Error:', joinedError);
  } else {
    console.log('Joined Count:', joinedData.length);
  }
}

debug();
