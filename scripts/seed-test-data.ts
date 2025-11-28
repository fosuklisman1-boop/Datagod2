import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function seedTestData() {
  try {
    console.log('Starting test data seed...')

    // 1. Get or create networks
    const { data: networks, error: networkError } = await supabase
      .from('networks')
      .select('id, name')

    if (networkError) {
      console.error('Error fetching networks:', networkError)
      return
    }

    console.log(`Found ${networks?.length || 0} networks`)

    // 2. Get packages
    const { data: packages, error: packagesError } = await supabase
      .from('packages')
      .select('id, network, size, price, description')
      .limit(5)

    if (packagesError) {
      console.error('Error fetching packages:', packagesError)
      return
    }

    console.log(`Found ${packages?.length || 0} packages`)
    if (packages) {
      console.log('Sample packages:', JSON.stringify(packages.slice(0, 2), null, 2))
    }

    // 3. Get the shop
    const { data: shop, error: shopError } = await supabase
      .from('user_shops')
      .select('id, shop_slug')
      .eq('shop_slug', 'clings')
      .single()

    if (shopError) {
      console.error('Error fetching shop:', shopError)
      return
    }

    console.log(`Found shop: ${shop.shop_slug} (ID: ${shop.id})`)

    // 4. Check existing shop_packages
    const { data: existingShopPackages, error: existingError } = await supabase
      .from('shop_packages')
      .select('id')
      .eq('shop_id', shop.id)

    console.log(`Found ${existingShopPackages?.length || 0} existing shop_packages`)

    if (!existingShopPackages || existingShopPackages.length === 0) {
      console.log('Adding shop packages...')
      
      // Add some packages to the shop
      if (packages && packages.length > 0) {
        const shopPackagesToInsert = packages.slice(0, 5).map((pkg) => ({
          shop_id: shop.id,
          package_id: pkg.id,
          profit_margin: 10,
          is_available: true,
        }))

        const { data: inserted, error: insertError } = await supabase
          .from('shop_packages')
          .insert(shopPackagesToInsert)
          .select()

        if (insertError) {
          console.error('Error inserting shop packages:', insertError)
        } else {
          console.log(`Successfully inserted ${inserted?.length || 0} shop packages`)
        }
      }
    }

    console.log('Test data seed complete!')
  } catch (error) {
    console.error('Error during seed:', error)
  }
}

seedTestData()
