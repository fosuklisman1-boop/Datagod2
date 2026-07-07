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

import { groupPhonesByNetwork } from './order-phone-network'
import type { RawPhoneRow } from './order-phone-network'

function row(p: Partial<RawPhoneRow>): RawPhoneRow {
  return {
    source_table: 'orders',
    product_type: 'data',
    network_raw: 'MTN',
    phone: '0241234567',
    normalized: true,
    order_count: 1,
    first_order_at: '2026-01-01T00:00:00Z',
    last_order_at: '2026-01-01T00:00:00Z',
    ...p,
  }
}

describe('groupPhonesByNetwork', () => {
  it('always returns all six sheets, even when empty', () => {
    const g = groupPhonesByNetwork([])
    expect([...g.keys()]).toEqual([...NETWORK_SHEETS])
    for (const s of NETWORK_SHEETS) expect(g.get(s)).toEqual([])
  })

  it('places a network-bearing order in its network sheet', () => {
    const g = groupPhonesByNetwork([row({ network_raw: 'Telecel', phone: '0201112223' })])
    expect(g.get('Telecel')!.map(e => e.phone)).toEqual(['0201112223'])
    expect(g.get('MTN')).toEqual([])
  })

  it('merges duplicate phones within a network (sum counts, widen date range, union products)', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'orders', product_type: 'data', order_count: 3,
            first_order_at: '2026-01-01T00:00:00Z', last_order_at: '2026-02-01T00:00:00Z' }),
      row({ source_table: 'airtime_orders', product_type: 'airtime', order_count: 2,
            first_order_at: '2025-12-01T00:00:00Z', last_order_at: '2026-03-01T00:00:00Z' }),
    ])
    const e = g.get('MTN')!.find(x => x.phone === '0241234567')!
    expect(e.orderCount).toBe(5)
    expect(e.firstOrderAt).toBe('2025-12-01T00:00:00Z')
    expect(e.lastOrderAt).toBe('2026-03-01T00:00:00Z')
    expect(e.products).toEqual(['airtime', 'data'])
  })

  it('known-network-wins: an AFA phone also seen on an AT order goes to AT, not prefix', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'api_orders', network_raw: 'AT', phone: '0241234567' }), // MTN prefix, but known AT
      row({ source_table: 'afa_orders', product_type: 'afa', network_raw: null, phone: '0241234567' }),
    ])
    expect(g.get('AT')!.find(e => e.phone === '0241234567')!.orderCount).toBe(2)
    expect(g.get('MTN')).toEqual([])
  })

  it('AFA with no known network defaults to MTN (ignoring prefix)', () => {
    // 0271234567 is an AT prefix, but AFA => MTN when otherwise unknown.
    const g = groupPhonesByNetwork([
      row({ source_table: 'afa_orders', product_type: 'afa', network_raw: null, phone: '0271234567' }),
    ])
    expect(g.get('MTN')!.map(e => e.phone)).toEqual(['0271234567'])
    expect(g.get('AT')).toEqual([])
  })

  it('results-checker with no known network infers from phone prefix', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'results_checker_orders', product_type: 'results', network_raw: null, phone: '0271234567' }),
    ])
    expect(g.get('AT')!.map(e => e.phone)).toEqual(['0271234567'])
  })

  it('un-normalizable / unknown-prefix phones land in Unknown, never dropped', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'results_checker_orders', product_type: 'results', network_raw: null,
            phone: 'garbage', normalized: false }),
    ])
    expect(g.get('Unknown')!.map(e => e.phone)).toEqual(['garbage'])
  })

  it('a phone bought on two networks appears in both sheets', () => {
    const g = groupPhonesByNetwork([
      row({ network_raw: 'MTN', phone: '0241234567' }),
      row({ network_raw: 'AT', phone: '0241234567' }),
    ])
    expect(g.get('MTN')!.some(e => e.phone === '0241234567')).toBe(true)
    expect(g.get('AT')!.some(e => e.phone === '0241234567')).toBe(true)
  })

  it('maps an unexpected network_raw value to Unknown', () => {
    const g = groupPhonesByNetwork([row({ network_raw: 'GLO', phone: '0241234567' })])
    expect(g.get('Unknown')!.map(e => e.phone)).toEqual(['0241234567'])
  })

  it('sorts each sheet by order count descending', () => {
    const g = groupPhonesByNetwork([
      row({ phone: '0241111111', order_count: 1 }),
      row({ phone: '0242222222', order_count: 9 }),
    ])
    expect(g.get('MTN')!.map(e => e.phone)).toEqual(['0242222222', '0241111111'])
  })
})

import { toSheetRows, buildSummaryRows } from './order-phone-network'

describe('toSheetRows', () => {
  it('shapes entries into flat spreadsheet rows with date-only dates', () => {
    const rows = toSheetRows([
      { phone: '0241234567', orderCount: 4, firstOrderAt: '2026-01-02T09:00:00Z',
        lastOrderAt: '2026-03-04T10:00:00Z', products: ['airtime', 'data'] },
    ])
    expect(rows).toEqual([
      { Phone: '0241234567', Orders: 4, 'First Order': '2026-01-02',
        'Last Order': '2026-03-04', Products: 'airtime, data' },
    ])
  })

  it('renders empty dates as empty strings', () => {
    const rows = toSheetRows([
      { phone: 'garbage', orderCount: 1, firstOrderAt: null, lastOrderAt: null, products: ['results'] },
    ])
    expect(rows[0]['First Order']).toBe('')
    expect(rows[0]['Last Order']).toBe('')
  })
})

describe('buildSummaryRows', () => {
  it('produces one row per network plus a TOTAL row', () => {
    const g = groupPhonesByNetwork([
      row({ network_raw: 'MTN', phone: '0241234567', order_count: 3 }),
      row({ network_raw: 'MTN', phone: '0242222222', order_count: 1 }),
      row({ network_raw: 'Telecel', phone: '0201112223', order_count: 2 }),
    ])
    const summary = buildSummaryRows(g)
    const mtn = summary.find(s => s.Network === 'MTN')!
    expect(mtn['Unique Phones']).toBe(2)
    expect(mtn['Total Orders']).toBe(4)
    const total = summary.find(s => s.Network === 'TOTAL')!
    expect(total['Unique Phones']).toBe(3)
    expect(total['Total Orders']).toBe(6)
  })
})
