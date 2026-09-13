import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideMtnGate, statusColumnFor, HOLD_STATUS, MTN_ORDER_TABLES } from './mtn-hold'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

/** Minimal fake client: `.from(table).select(col).eq(statusCol, val)` resolves
 *  to whatever rows are configured for that table. */
function fakeSupabase(rowsByTable: Record<string, any[]>) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return Promise.resolve({ data: rowsByTable[table] ?? [], error: null })
            },
          }
        },
      }
    },
  }
}

describe('decideMtnGate', () => {
  it('never holds when the gate is disabled', () => {
    expect(decideMtnGate(false, 'pending').hold).toBe(false)
    expect(decideMtnGate(false, null).hold).toBe(false)
  })
  it('passes registered numbers', () => {
    expect(decideMtnGate(true, 'registered').hold).toBe(false)
  })
  it('holds pending / submitted', () => {
    expect(decideMtnGate(true, 'pending').hold).toBe(true)
    expect(decideMtnGate(true, 'submitted').hold).toBe(true)
  })
  it('passes rejected numbers through (fail-fast at provider, never held)', () => {
    // A rejected number (non-MTN prefix / provider-rejected) can never be
    // activated — holding would strand the order forever. Let it fail at the
    // provider and land in the manual queue, exactly as before the gate.
    expect(decideMtnGate(true, 'rejected').hold).toBe(false)
  })
  it('holds when the number is missing from the registry', () => {
    expect(decideMtnGate(true, null).hold).toBe(true)
  })
})

describe('statusColumnFor', () => {
  it('maps every MTN order table to its status column', () => {
    expect(statusColumnFor('orders')).toBe('status')
    expect(statusColumnFor('api_orders')).toBe('status')
    expect(statusColumnFor('shop_orders')).toBe('order_status')
    expect(statusColumnFor('ussd_orders')).toBe('order_status')
    expect(statusColumnFor('ussd_shop_orders')).toBe('order_status')
  })
  it('covers exactly the 5 data tables', () => {
    expect([...MTN_ORDER_TABLES].sort()).toEqual(
      ['api_orders', 'orders', 'shop_orders', 'ussd_orders', 'ussd_shop_orders'].sort()
    )
  })
})

describe('HOLD_STATUS', () => {
  it('is the dedicated held status value', () => {
    expect(HOLD_STATUS).toBe('held_registration')
  })
})

describe('getHeldOrderPhones', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('collects normalized, deduped phones across all 5 order tables', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const { getHeldOrderPhones } = await import('./mtn-hold')
    vi.mocked(createClient).mockReturnValue(fakeSupabase({
      orders: [{ phone_number: '0551111111' }],
      shop_orders: [{ customer_phone: '+233551111111' }], // same number, different format -> dedup
      api_orders: [{ recipient_phone: '0552222222' }],
      ussd_orders: [],
      ussd_shop_orders: [],
    }) as any)

    const phones = await getHeldOrderPhones()
    expect(phones.sort()).toEqual(['0551111111', '0552222222'])
  })

  it('returns an empty array when nothing is held', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const { getHeldOrderPhones } = await import('./mtn-hold')
    vi.mocked(createClient).mockReturnValue(fakeSupabase({}) as any)

    expect(await getHeldOrderPhones()).toEqual([])
  })
})
