import { describe, it, expect } from 'vitest'
import { decideMtnGate, statusColumnFor, HOLD_STATUS, MTN_ORDER_TABLES } from './mtn-hold'

describe('decideMtnGate', () => {
  it('never holds when the gate is disabled', () => {
    expect(decideMtnGate(false, 'pending').hold).toBe(false)
    expect(decideMtnGate(false, null).hold).toBe(false)
  })
  it('passes registered numbers', () => {
    expect(decideMtnGate(true, 'registered').hold).toBe(false)
  })
  it('holds pending / submitted / rejected', () => {
    expect(decideMtnGate(true, 'pending').hold).toBe(true)
    expect(decideMtnGate(true, 'submitted').hold).toBe(true)
    expect(decideMtnGate(true, 'rejected').hold).toBe(true)
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
