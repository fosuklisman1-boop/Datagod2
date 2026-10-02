// Class-name mappings for the 3 bottom-nav skins (default/dealer/admin) --
// the mobile floating pill nav's equivalent of lib/sidebar-theme.ts. Colors
// mirror the same real per-role identity already used elsewhere in the
// customer rebuild: navy #1b388b for default/normal users (e.g. the Wallet
// balance hero, sidebar default skin), amber/warning for dealer ("Bold
// Telco" -- same isDealer ? "bg-warning" : ... convention as Wallet), and
// the admin panel's own dark navy (--admin-sidebar, same as the desktop
// admin sidebar skin) while browsing /admin pages.
export type BottomNavSkin = 'default' | 'dealer' | 'admin'

export interface BottomNavSkinClasses {
  bar: string
  navLinkActive: string
  navLinkInactive: string
  fabCircle: string
  fabIconText: string
  fabLabelActive: string
  fabLabelInactive: string
}

const SKIN_CLASSES: Record<BottomNavSkin, BottomNavSkinClasses> = {
  default: {
    bar: 'bg-card border border-border',
    navLinkActive: 'text-[#1b388b]',
    navLinkInactive: 'text-muted-foreground',
    fabCircle: 'bg-[#1b388b]/15 ring-4 ring-card',
    fabIconText: 'text-[#1b388b]',
    fabLabelActive: 'text-[#1b388b]',
    fabLabelInactive: 'text-[#1b388b]/70',
  },
  dealer: {
    bar: 'bg-amber-50 border border-amber-200/60',
    navLinkActive: 'text-amber-800',
    navLinkInactive: 'text-amber-700/50',
    fabCircle: 'bg-amber-200/70 ring-4 ring-amber-50',
    fabIconText: 'text-amber-900',
    fabLabelActive: 'text-amber-900',
    fabLabelInactive: 'text-amber-800/70',
  },
  admin: {
    bar: 'bg-admin-sidebar border border-white/10',
    navLinkActive: 'text-white',
    navLinkInactive: 'text-white/50',
    fabCircle: 'bg-white/15 ring-4 ring-admin-sidebar',
    fabIconText: 'text-white',
    fabLabelActive: 'text-white',
    fabLabelInactive: 'text-white/70',
  },
}

export function bottomNavSkinClasses(skin: BottomNavSkin): BottomNavSkinClasses {
  return SKIN_CLASSES[skin]
}
