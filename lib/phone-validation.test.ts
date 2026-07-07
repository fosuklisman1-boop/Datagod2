import { describe, it, expect } from 'vitest'
import { validatePhoneNumber } from './phone-validation'
import { DEFAULT_NETWORK_PREFIXES } from './phone-format'

describe('validatePhoneNumber (network-aware, strict)', () => {
  it('MTN rejects a Telecel number (the historical hole)', () => {
    const res = validatePhoneNumber('0201234567', 'MTN')
    expect(res.isValid).toBe(false)
    expect(res.error).toContain('Telecel')
  })
  it('MTN rejects an AT number', () => {
    expect(validatePhoneNumber('0271234567', 'MTN').isValid).toBe(false)
  })
  it('MTN accepts all MTN prefixes incl. 053', () => {
    for (const p of DEFAULT_NETWORK_PREFIXES.MTN) {
      expect(validatePhoneNumber(`0${p}1234567`, 'MTN').isValid).toBe(true)
    }
  })
  it('Telecel behavior stays strict', () => {
    expect(validatePhoneNumber('0201234567', 'Telecel').isValid).toBe(true)
    expect(validatePhoneNumber('0241234567', 'Telecel').isValid).toBe(false)
  })
  it('AT product names map to AT prefixes', () => {
    expect(validatePhoneNumber('0271234567', 'AT - iShare').isValid).toBe(true)
    expect(validatePhoneNumber('0241234567', 'AT - BigTime').isValid).toBe(false)
  })
  it('9-digit padding still works', () => {
    const res = validatePhoneNumber('241234567', 'MTN')
    expect(res.isValid).toBe(true)
    expect(res.normalized).toBe('0241234567')
  })
  it('no network → generic 02/05 validation unchanged', () => {
    expect(validatePhoneNumber('0201234567').isValid).toBe(true)
    expect(validatePhoneNumber('0611234567').isValid).toBe(false)
  })
  it('accepts a custom map (admin-added prefix)', () => {
    const extended = { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, '58'] }
    expect(validatePhoneNumber('0581234567', 'MTN', extended).isValid).toBe(true)
    expect(validatePhoneNumber('0581234567', 'MTN').isValid).toBe(false)
  })
})
