import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Initialize Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params

    // Get shop data from user_shops table
    const { data: shop, error: shopError } = await supabase
      .from('user_shops')
      .select('*')
      .eq('shop_slug', slug)
      .eq('is_active', true)
      .single()

    if (shopError || !shop) {
      return NextResponse.json(
        { error: 'Shop not found' },
        { status: 404 }
      )
    }

    // Get packages for this shop with nested package data
    const { data: shopPackages, error: packagesError } = await supabase
      .from('shop_packages')
      .select(`
        *,
        packages (
          id,
          network,
          size,
          price,
          description
        )
      `)
      .eq('shop_id', shop.id)
      .eq('is_available', true)

    if (packagesError) {
      return NextResponse.json(
        { error: 'Failed to fetch packages' },
        { status: 500 }
      )
    }

    // Get unique networks from packages
    const networks = shopPackages
      ? [...new Set(shopPackages.map((sp: any) => sp.packages?.network))].filter(Boolean)
      : []

    // Return combined data
    return NextResponse.json({
      id: shop.id,
      name: shop.shop_name,
      slug: shop.shop_slug,
      networks: networks.map((network: string) => ({
        id: network,
        name: network,
        slug: network,
      })),
      packages: (shopPackages || []).map((sp: any) => ({
        id: sp.packages?.id,
        network_id: sp.packages?.network,
        description: sp.packages?.description,
        price: sp.packages?.price,
        size: sp.packages?.size,
        shop_package_id: sp.id,
        package_id: sp.package_id,
        profit_margin: sp.profit_margin,
      })),
    })
  } catch (error) {
    console.error('Error in GET /api/shops/[slug]:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
