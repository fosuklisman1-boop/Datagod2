import { describe, it, expect } from 'vitest'
import { statusPillClasses, segmentedPillItemClasses } from './admin-theme'

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
