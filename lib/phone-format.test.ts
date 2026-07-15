import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NETWORK_PREFIXES,
  detectGhanaNetwork,
  detectNetworkWithMap,
  validateNetworkPrefix,
} from './phone-format'

describe('DEFAULT_NETWORK_PREFIXES', () => {
  it('pins the canonical seed — 053 IS MTN', () => {
    expect(DEFAULT_NETWORK_PREFIXES).toEqual({
      MTN: ['24', '25', '53', '54', '55', '59'],
      TELECEL: ['20', '50'],
      AT: ['26', '27', '56', '57'],
    })
  })
})

describe('detectNetworkWithMap', () => {
  it('matches detectGhanaNetwork on the default map for every seed prefix', () => {
    for (const [net, prefixes] of Object.entries(DEFAULT_NETWORK_PREFIXES)) {
      for (const p of prefixes) {
        const phone = `0${p}1234567`
        expect(detectNetworkWithMap(phone, DEFAULT_NETWORK_PREFIXES)).toBe(net)
        expect(detectGhanaNetwork(phone)).toBe(net)
      }
    }
  })
  it('honors an extended map (admin-added prefix)', () => {
    const extended = { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, '58'] }
    expect(detectNetworkWithMap('0581234567', extended)).toBe('MTN')
    expect(detectNetworkWithMap('0581234567', DEFAULT_NETWORK_PREFIXES)).toBe('UNKNOWN')
  })
})

describe('validateNetworkPrefix', () => {
  // Full seed matrix: every prefix vs every order-network string.
  const NETWORK_STRINGS: Array<[string, keyof typeof DEFAULT_NETWORK_PREFIXES]> = [
    ['MTN', 'MTN'], ['mtn', 'MTN'],
    ['Telecel', 'TELECEL'], ['TELECEL', 'TELECEL'],
    ['AT', 'AT'], ['AirtelTigo', 'AT'], ['AT - iShare', 'AT'], ['at-ishare', 'AT'],
    ['AT - BigTime', 'AT'], ['bigtime', 'AT'],
  ]
  it('accepts matching prefixes and rejects mismatches, for every seed prefix', () => {
    for (const [orderNet, carrier] of NETWORK_STRINGS) {
      for (const [net, prefixes] of Object.entries(DEFAULT_NETWORK_PREFIXES)) {
        for (const p of prefixes) {
          const res = validateNetworkPrefix(orderNet, `0${p}1234567`)
          expect(res.ok).toBe(net === carrier)
        }
      }
    }
  })
  it('053 + MTN passes (explicit pin)', () => {
    expect(validateNetworkPrefix('MTN', '0531234567').ok).toBe(true)
  })
  it('020 + MTN fails with a helpful message (the historical hole)', () => {
    const res = validateNetworkPrefix('MTN', '0201234567')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('Telecel')
  })
  it('blocks unknown prefixes', () => {
    const res = validateNetworkPrefix('MTN', '0231234567')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message.toLowerCase()).toContain('check the number')
  })
  it('blocks invalid formats', () => {
    expect(validateNetworkPrefix('MTN', 'abc').ok).toBe(false)
    expect(validateNetworkPrefix('MTN', '024123').ok).toBe(false)
  })
  it('normalizes 233/+233/spaced input before judging', () => {
    expect(validateNetworkPrefix('MTN', '233241234567').ok).toBe(true)
    expect(validateNetworkPrefix('MTN', '+233 24 123 4567').ok).toBe(true)
  })
  it('passes an unrecognized order-network string (never blocks what it does not understand)', () => {
    expect(validateNetworkPrefix('AFA', '0201234567').ok).toBe(true)
  })
  it('uses a custom map when provided', () => {
    const extended = { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, '58'] }
    expect(validateNetworkPrefix('MTN', '0581234567', extended).ok).toBe(true)
    expect(validateNetworkPrefix('Telecel', '0581234567', extended).ok).toBe(false)
  })
})
