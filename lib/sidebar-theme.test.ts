import { describe, it, expect } from 'vitest'
import { sidebarSkinClasses } from './sidebar-theme'

describe('sidebarSkinClasses', () => {
  it('returns the same fixed-navy classes as "admin" for "default" (customer-dashboard rebuild made these deliberately identical)', () => {
    expect(sidebarSkinClasses('default')).toEqual(sidebarSkinClasses('admin'))
  })

  it('returns the exact current literal classes for "dealer" (regression guard)', () => {
    expect(sidebarSkinClasses('dealer')).toEqual({
      container: 'bg-sidebar text-sidebar-foreground border-r border-sidebar-border',
      logoSectionBorder: 'border-white/10',
      userIdentityText: 'text-primary',
      collapseButtonHover: 'text-sidebar-foreground hover:bg-sidebar-accent',
      navLinkActive: 'bg-sidebar-accent text-sidebar-accent-foreground shadow-lg',
      navLinkInactive: 'text-primary hover:bg-card/10',
      sectionBorder: 'border-white/10',
      sectionLabelText: 'text-primary/80',
      logoutText: 'text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive',
    })
  })

  it('returns the new fixed-navy classes for "admin"', () => {
    expect(sidebarSkinClasses('admin')).toEqual({
      container: 'bg-admin-sidebar text-admin-sidebar-foreground border-r border-white/10',
      logoSectionBorder: 'border-white/10',
      userIdentityText: 'text-white/70',
      collapseButtonHover: 'text-white hover:bg-white/10',
      navLinkActive: 'bg-white/12 text-white font-medium',
      navLinkInactive: 'text-white/65 hover:bg-white/8 hover:text-white',
      sectionBorder: 'border-white/10',
      sectionLabelText: 'text-white/40',
      logoutText: 'text-white/80 hover:bg-destructive/10 hover:text-destructive',
    })
  })
})
