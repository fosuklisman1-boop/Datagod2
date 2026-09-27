import { describe, it, expect } from 'vitest'
import { statusPillClasses } from './admin-theme'

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
