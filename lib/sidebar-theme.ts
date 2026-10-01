// Class-name mappings for the 3 sidebar skins (default/dealer/admin).
// 'default' is a light sidebar with a navy active-item highlight --
// reverted from a brief "fixed navy for everyone" experiment after the
// active nav item turned out invisible (white text on a light drawer
// background in practice). 'admin' keeps its own fixed-navy identity,
// 'dealer' its own purple "Bold Telco" skin.
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
    container: 'bg-sidebar text-sidebar-foreground border-r border-sidebar-border',
    logoSectionBorder: 'border-sidebar-border',
    userIdentityText: 'text-muted-foreground',
    collapseButtonHover: 'text-sidebar-foreground hover:bg-accent',
    navLinkActive: 'bg-[#1b388b]/10 text-[#1b388b] font-medium',
    navLinkInactive: 'text-sidebar-foreground hover:bg-accent',
    sectionBorder: 'border-sidebar-border',
    sectionLabelText: 'text-muted-foreground',
    logoutText: 'text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive',
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
