const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function getColumns() {
  const { data, error } = await supabase
    .from('order_download_batches')
    .select('*')
    .limit(1);

  if (error) {
    console.error("Error fetching columns:", error);
    // If table doesn't exist, we'll see that too
  } else {
    console.log("Columns in order_download_batches:", Object.keys(data[0] || {}));
  }
}

getColumns();
