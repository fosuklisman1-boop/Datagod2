
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const { createClient } = require('@supabase/supabase-js')

if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing env vars")
    process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function checkPriceConsistency(subAgentEmail) {
    console.log(`Checking for sub-agent: ${subAgentEmail}`)

    // 1. Get Sub-Agent User & Shop
    const { data: user, error: userError } = await supabase.from('users').select('id, role').eq('email', subAgentEmail).single()
    if (userError) { console.error("User error:", userError); return }

    const { data: shop, error: shopError } = await supabase.from('user_shops').select('id, parent_shop_id').eq('user_id', user.id).single()
    if (shopError) { console.error("Shop error:", shopError); return }

    if (!shop.parent_shop_id) { console.log("Not a sub-agent shop"); return }

    console.log(`Sub-Agent Shop ID: ${shop.id}, Parent Shop ID: ${shop.parent_shop_id}`)

    // 2. Get Parent Shop & Role
    const { data: parentShop } = await supabase.from('user_shops').select('user_id').eq('id', shop.parent_shop_id).single()
    const { data: parentUser } = await supabase.from('users').select('role').eq('id', parentShop.user_id).single()

    const isParentDealer = parentUser?.role === 'dealer' || parentUser?.role === 'admin'
    console.log(`Parent Role: ${parentUser?.role}, Is Dealer: ${isParentDealer}`)

    // 3. Get Catalog Items
    const { data: catalogItems } = await supabase
        .from("sub_agent_catalog")
        .select(`id, package_id, wholesale_margin, package:packages(id, network, size, price, dealer_price)`)
        .eq("shop_id", shop.parent_shop_id)
        .eq("is_active", true)

    console.log(`Found ${catalogItems.length} catalog items`)

    catalogItems.forEach(item => {
        const pkg = item.package
        const adminPrice = (isParentDealer && pkg.dealer_price > 0) ? pkg.dealer_price : pkg.price
        const parentPrice = adminPrice + item.wholesale_margin

        console.log(`Package ${pkg.network} ${pkg.size}:`)
        console.log(`  Admin Price: ${adminPrice} (Standard: ${pkg.price}, Dealer: ${pkg.dealer_price})`)
        console.log(`  Wholesale Margin: ${item.wholesale_margin}`)
        console.log(`  Expected Parent Price (Buy Stock Price): ${parentPrice.toFixed(2)}`)
    })
}

// Replace with the email from the logs if available, or just run generic check
checkPriceConsistency('d@gmail.com')
