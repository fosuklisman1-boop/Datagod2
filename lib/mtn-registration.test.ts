import { describe, it, expect } from 'vitest'
import { buildMtnRegistrationRows, parseClaimResult } from './mtn-registration'

describe('buildMtnRegistrationRows', () => {
  it('shapes phones into single-column sheet rows', () => {
    expect(buildMtnRegistrationRows(['0241234567', '0551112223'])).toEqual([
      { Phone: '0241234567' },
      { Phone: '0551112223' },
    ])
  })
  it('returns empty array for no phones', () => {
    expect(buildMtnRegistrationRows([])).toEqual([])
  })
})

describe('parseClaimResult', () => {
  it('parses a successful claim payload', () => {
    const r = parseClaimResult({ batch_id: 'b1', count: 2, phones: ['0241234567', '0551112223'] })
    expect(r).toEqual({ batchId: 'b1', count: 2, phones: ['0241234567', '0551112223'] })
  })
  it('parses the empty-claim payload (null batch_id)', () => {
    const r = parseClaimResult({ batch_id: null, count: 0, phones: [] })
    expect(r).toEqual({ batchId: null, count: 0, phones: [] })
  })
  it('is defensive about malformed input', () => {
    expect(parseClaimResult(null)).toEqual({ batchId: null, count: 0, phones: [] })
    expect(parseClaimResult({})).toEqual({ batchId: null, count: 0, phones: [] })
    expect(parseClaimResult({ batch_id: 'b', count: '3', phones: 'nope' }))
      .toEqual({ batchId: 'b', count: 3, phones: [] })
  })
})
