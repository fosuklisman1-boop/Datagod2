import { describe, it, expect } from 'vitest'
import { statusPillClasses, segmentedPillItemClasses, gatewayStatus, gatewayBarColorClass, networkBadgeClasses } from './admin-theme'

describe('statusPillClasses', () => {
  it('returns success-token classes for "success"', () => {
    expect(statusPillClasses('success')).toBe('bg-success/10 text-success border border-success/30')
  })

  it('returns warning-token classes for "warning"', () => {
    expect(statusPillClasses('warning')).toBe('bg-warning/10 text-warning border border-warning/30')
  })

  it('returns destructive-token classes for "danger"', () => {
    expect(statusPillClasses('danger')).toBe('bg-destructive/10 text-destructive border border-destructive/30')
  })
})

describe('segmentedPillItemClasses', () => {
  it('returns the amber active state when active', () => {
    expect(segmentedPillItemClasses(true)).toBe('bg-admin-amber text-slate-900 font-bold')
  })

  it('returns the transparent inactive state when not active', () => {
    expect(segmentedPillItemClasses(false)).toBe('bg-transparent text-current font-medium hover:bg-white/10')
  })
})

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
})
