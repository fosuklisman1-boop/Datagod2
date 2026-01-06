import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  try {
    // Test database connection
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .limit(1)

    if (error) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          database: 'disconnected'
        },
        { status: 500 }
      )
    }

    // Check if key tables exist by querying them
    const tableTests = {
      mtn_fulfillment_tracking: await checkTable('mtn_fulfillment_tracking'),
      app_settings: await checkTable('app_settings'),
      shop_orders: await checkTable('shop_orders'),
      users: await checkTable('users')
    }

    return NextResponse.json({
      success: true,
      database: 'connected',
      tables: tableTests,
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Database check failed',
        database: 'error'
      },
      { status: 500 }
    )
  }
}

async function checkTable(tableName: string): Promise<string> {
  try {
    const { data, error } = await supabase
      .from(tableName)
      .select('count()', { count: 'exact', head: true })

    if (error) {
      return '✗ Not found'
    }
    return '✓ Exists'
  } catch {
    return '✗ Error'
  }
}
