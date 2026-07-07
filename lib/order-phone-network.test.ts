import { describe, it, expect } from 'vitest'
import { ORDER_SOURCE_TABLES, NETWORK_SHEETS } from './order-phone-network'

describe('order source coverage (no order type missed)', () => {
  it('lists exactly the 9 known order tables', () => {
    expect([...ORDER_SOURCE_TABLES].sort()).toEqual(
      [
        'afa_orders',
        'airtime_orders',
        'api_orders',
        'orders',
        'results_checker_orders',
        'shop_orders',
        'ussd_afa_orders',
        'ussd_orders',
        'ussd_shop_orders',
      ].sort()
    )
    // If a new order table is ever added, wire it into the view AND this list.
    expect(ORDER_SOURCE_TABLES).toHaveLength(9)
  })

  it('exposes the six network sheets in display order', () => {
    expect(NETWORK_SHEETS).toEqual([
      'MTN', 'Telecel', 'AT', 'AT - iShare', 'AT - BigTime', 'Unknown',
    ])
  })
})
