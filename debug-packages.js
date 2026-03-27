const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function listMtnPackages() {
  const { data, error } = await supabase
    .from('packages')
    .select('network, size, is_available')
    .ilike('network', 'MTN%');
    
  if (error) {
    console.error("Error:", error);
    return;
  }
  
  console.log("MTN Packages:");
  console.log(JSON.stringify(data, null, 2));
}

listMtnPackages();
