// Class-name mappings for the 3 sidebar skins (default/dealer/admin).
// 'default' and 'admin' are now deliberately identical (fixed navy) --
// regular customers get the same sidebar chrome as admins, per the
// customer-dashboard rebuild. Only 'dealer' keeps a distinct identity
// (its own purple "Bold Telco" skin, unchanged).
export type SidebarSkin = 'default' | 'dealer' | 'admin'

export interface SidebarSkinClasses {
  container: string
  logoSectionBorder: string
  userIdentityText: string
  collapseButtonHover: string
  navLinkActive: string
  navLinkInactive: string
  sectionBorder: string
  sectionLabelText: string
  logoutText: string
}

const SKIN_CLASSES: Record<SidebarSkin, SidebarSkinClasses> = {
  default: {
    container: 'bg-admin-sidebar text-admin-sidebar-foreground border-r border-white/10',
    logoSectionBorder: 'border-white/10',
    userIdentityText: 'text-white/70',
    collapseButtonHover: 'text-white hover:bg-white/10',
    navLinkActive: 'bg-white/12 text-white font-medium',
    navLinkInactive: 'text-white/65 hover:bg-white/8 hover:text-white',
    sectionBorder: 'border-white/10',
    sectionLabelText: 'text-white/40',
    logoutText: 'text-white/80 hover:bg-destructive/10 hover:text-destructive',
  },
  dealer: {
    container: 'bg-sidebar text-sidebar-foreground border-r border-sidebar-border',
    logoSectionBorder: 'border-white/10',
    userIdentityText: 'text-primary',
    collapseButtonHover: 'text-sidebar-foreground hover:bg-sidebar-accent',
    navLinkActive: 'bg-sidebar-accent text-sidebar-accent-foreground shadow-lg',
    navLinkInactive: 'text-primary hover:bg-card/10',
    sectionBorder: 'border-white/10',
    sectionLabelText: 'text-primary/80',
    logoutText: 'text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive',
  },
  admin: {
    container: 'bg-admin-sidebar text-admin-sidebar-foreground border-r border-white/10',
    logoSectionBorder: 'border-white/10',
    userIdentityText: 'text-white/70',
    collapseButtonHover: 'text-white hover:bg-white/10',
    navLinkActive: 'bg-white/12 text-white font-medium',
    navLinkInactive: 'text-white/65 hover:bg-white/8 hover:text-white',
    sectionBorder: 'border-white/10',
    sectionLabelText: 'text-white/40',
    logoutText: 'text-white/80 hover:bg-destructive/10 hover:text-destructive',
  },
}

export function sidebarSkinClasses(skin: SidebarSkin): SidebarSkinClasses {
  return SKIN_CLASSES[skin]
}
