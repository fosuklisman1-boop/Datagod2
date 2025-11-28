import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  try {
    // Get all shops
    const { data: shops, error: shopsError } = await supabase
      .from('user_shops')
      .select('id, shop_name, shop_slug')
      .eq('is_active', true)
      .limit(10)

    if (shopsError) {
      return NextResponse.json({
        error: 'Failed to fetch shops',
        details: shopsError.message,
      }, { status: 500 })
    }

    return NextResponse.json({
      shops,
      count: shops?.length || 0,
    })
  } catch (error) {
    console.error('Error in GET /api/debug/shops:', error)
    return NextResponse.json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 })
  }
}
