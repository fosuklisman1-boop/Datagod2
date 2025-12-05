// Quick test to check if is_available column exists
// Run this with: node test-package-column.js

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function testColumn() {
  try {
    const { data, error } = await supabase
      .from('packages')
      .select('id, network, size, price, is_available')
      .limit(1)

    if (error) {
      console.error('❌ Error:', error.message)
      if (error.message.includes('is_available')) {
        console.log('\n⚠️  The is_available column does NOT exist yet!')
        console.log('You need to run the SQL migration in Supabase SQL Editor:')
        console.log('\nALTER TABLE packages ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT TRUE;')
      }
    } else {
      console.log('✅ Success! Column exists')
      console.log('Sample data:', data)
    }
  } catch (err) {
    console.error('❌ Error:', err.message)
  }
}

testColumn()
