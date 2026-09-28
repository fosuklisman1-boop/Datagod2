import { describe, it, expect } from 'vitest'
import { gatewayStatus, gatewayBarColorClass, networkBadgeClasses } from './network-status-theme'

describe('gatewayStatus', () => {
  it('is "optimal" at 99% uptime or above', () => {
    expect(gatewayStatus(99)).toBe('optimal')
    expect(gatewayStatus(99.9)).toBe('optimal')
    expect(gatewayStatus(100)).toBe('optimal')
  })

  it('is "degraded" between 90% (inclusive) and 99%', () => {
    expect(gatewayStatus(90)).toBe('degraded')
    expect(gatewayStatus(98.9)).toBe('degraded')
  })

  it('is "down" below 90%', () => {
    expect(gatewayStatus(89.9)).toBe('down')
    expect(gatewayStatus(0)).toBe('down')
  })
})

describe('gatewayBarColorClass', () => {
  it('maps each status to the matching semantic token', () => {
    expect(gatewayBarColorClass('optimal')).toBe('bg-success')
    expect(gatewayBarColorClass('degraded')).toBe('bg-warning')
    expect(gatewayBarColorClass('down')).toBe('bg-destructive')
  })
})

describe('networkBadgeClasses', () => {
  it('returns mtn badge classes for "mtn"', () => {
    expect(networkBadgeClasses('mtn')).toBe('bg-mtn text-mtn-foreground')
  })

  it('returns telecel badge classes for "telecel"', () => {
    expect(networkBadgeClasses('telecel')).toBe('bg-telecel text-telecel-foreground')
  })

  it('returns at badge classes for "at"', () => {
    expect(networkBadgeClasses('at')).toBe('bg-at text-at-foreground')
  })

  it('returns bigtime badge classes for "bigtime"', () => {
    expect(networkBadgeClasses('bigtime')).toBe('bg-violet-600 text-white')
  })
})
