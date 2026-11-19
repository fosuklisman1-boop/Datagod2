"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabase"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { isPathAllowedForService, isPageHidden } from "@/lib/custom-domains"
import {
  menuItems,
  menuGroups,
  shopItems,
  adminNavItems,
  adminNavGroups,
  isNavActive,
  type AdminNavBadge,
} from "@/lib/dashboard-nav-items"
import {
  groupNavItems,
  findActiveGroupId,
  isGroupOpen,
  openGroup,
  toggleGroup,
  parseGroupState,
  type GroupState,
  type NavGroupDef,
} from "@/lib/nav-groups"
import { roleFromMetadata } from "@/lib/metadata-role"
import { interimRightsFor, navVisible } from "@/lib/roles/capabilities"
import { useIsAdmin } from "@/hooks/use-admin"
import { useAppSettings } from "@/hooks/use-app-settings"
import { useAuth } from "@/hooks/use-auth"
import { sidebarSkinClasses, type SidebarSkin } from "@/lib/sidebar-theme"
import {
  MessageCircle,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Menu,
  Loader2,
  Crown,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState, useEffect, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { NewTag } from "./new-tag"
import { useNavNew } from "./use-nav-new"
import { useBillsAvailability, featureAvailable } from "@/components/bills/use-bills-availability"
import { useBundlesAvailability } from "@/components/standard-bundles/use-bundles-availability"

// Format large numbers with K/M suffix
const formatCount = (num: number): string => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 10000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toLocaleString()
}

/** Per-device open/closed state of the sidebar groups (lib/nav-groups.ts). */
// v2 (2026-11-16): groups now start closed; the new key drops choices saved under v1's open default.
const GROUP_STATE_KEY = "datagod.sidebarGroups.v2"

/** The whole Shop section is one collapsible group. */
const SHOP_GROUP: NavGroupDef = { id: "shop", label: "Shop" }

type NavLinkItem = { href: string; label: string; icon: LucideIcon }
type LinkOpts = {
  active: boolean
  badge?: number
  badgeSuffix?: string
  badgeTone?: "destructive" | "primary"
  tour?: string
}

function readGroupState(): GroupState {
  try {
    return parseGroupState(localStorage.getItem(GROUP_STATE_KEY))
  } catch {
    return {}
  }
}

function writeGroupState(state: GroupState) {
  try {
    localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(state))
  } catch {
    // private mode / storage blocked: the choice just isn't remembered
  }
}

export function Sidebar() {
  const pathname = usePathname()
  const { isAdmin } = useIsAdmin()
  const { joinCommunityLink } = useAppSettings()
  const { logout, user } = useAuth()
  const domainBranding = useDomainBranding()
  const [isOpen, setIsOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [userPendingOrderCount, setUserPendingOrderCount] = useState(0)
  const [adminPendingOrderCount, setAdminPendingOrderCount] = useState(0)
  const [waUnreadCount, setWaUnreadCount] = useState(0)
  const [waUnreadCapped, setWaUnreadCapped] = useState(false)
  const [userRole, setUserRole] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('userRole')
    }
    return null
  })
  const [dealerHasSubscription, setDealerHasSubscription] = useState(false)
  const [roleLoading, setRoleLoading] = useState(true)
  // Starts empty (= every group at its default) so SSR and first paint match;
  // the saved per-device choices load right after mount.
  const [groupState, setGroupState] = useState<GroupState>({})
  const skin: SidebarSkin = userRole === 'dealer' ? 'dealer' : (isAdmin || userRole === 'admin') ? 'admin' : 'default'
  const c = sidebarSkinClasses(skin)
  // Sidebar NEW tags: registry in lib/nav-new.ts, click counts on the user's account.
  const { isNew, markClicked } = useNavNew(user?.id)
  // Utility Bills / Broadband links show only when the feature is enabled.
  const billsAvailability = useBillsAvailability()
  const bundlesAvailability = useBundlesAvailability()

  const handleLogout = async () => {
    await logout()
  }

  // Fetch user role
  useEffect(() => {
    if (!user) {
      setRoleLoading(false)
      return
    }

    const fetchRole = async () => {
      try {
        setRoleLoading(true)
        const { data: userData } = await supabase
          .from("users")
          .select("role")
          .eq("id", user.id)
          .single()

        if (userData?.role) {
          setUserRole(userData.role)
          localStorage.setItem('userRole', userData.role)
          console.log("[SIDEBAR] User role from users table:", userData.role)

          if (userData.role === 'dealer') {
            const { data: sub } = await supabase
              .from("user_subscriptions")
              .select("id")
              .eq("user_id", user.id)
              .eq("status", "active")
              .maybeSingle()
            setDealerHasSubscription(!!sub)
          }
        } else {
          // Fallback: check user_metadata
          const { data: { user: authUser } } = await supabase.auth.getUser()
          // user_metadata is user-writable: roleFromMetadata never returns "admin".
          const metadataRole = roleFromMetadata(authUser?.user_metadata)
          if (metadataRole) {
            setUserRole(metadataRole)
            localStorage.setItem('userRole', metadataRole)
            console.log("[SIDEBAR] User role from metadata:", metadataRole)
          } else {
            setUserRole("user")
            localStorage.setItem('userRole', "user")
          }
        }
      } catch (error) {
        console.error("Error fetching user role:", error)
        setUserRole("user")
      } finally {
        setRoleLoading(false)
      }
    }

    fetchRole()
  }, [user])

  // Fetch pending orders count from localStorage
  useEffect(() => {
    if (!user) {
      console.log('[SIDEBAR] No user yet, waiting...')
      return
    }

    // Only update state when counts actually change to avoid needless re-renders
    const handleStorageChange = () => {
      const next = parseInt(localStorage.getItem('userPendingOrdersCount') || '0', 10)
      const nextAdmin = parseInt(localStorage.getItem('adminPendingOrdersCount') || '0', 10)
      setUserPendingOrderCount(prev => prev !== next ? next : prev)
      setAdminPendingOrderCount(prev => prev !== nextAdmin ? nextAdmin : prev)
    }

    // Check localStorage immediately
    handleStorageChange()

    // Listen for storage events (from other tabs/components)
    window.addEventListener('storage', handleStorageChange)

    // Also poll localStorage every 15 seconds in case it changes in same tab
    const interval = setInterval(handleStorageChange, 15000)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      clearInterval(interval)
    }
  }, [user])

  // Poll the WhatsApp inbox unread count for admins (badge on the inbox link).
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    const load = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) return
        const res = await fetch("/api/admin/whatsapp-inbox/unread-count", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) {
          setWaUnreadCount(typeof json.count === "number" ? json.count : 0)
          setWaUnreadCapped(json.capped === true)
        }
      } catch { /* transient */ }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [isAdmin])

  // Handle mobile responsiveness
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
      if (window.innerWidth < 768) {
        setIsOpen(false)
      }
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  // Emit sidebar state change event
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sidebarStateChange', { detail: { isOpen, isMobile } }));
    }
  }, [isOpen, isMobile]);

  // Clear loading state when pathname changes
  useEffect(() => {
    setLoadingPath(null)
  }, [pathname])

  // Which group holds the current page (longest href match across every list).
  const activeGroupId = useMemo(
    () =>
      findActiveGroupId(pathname ?? "", [
        ...menuItems,
        ...shopItems.map(i => ({ href: i.href, group: SHOP_GROUP.id })),
        ...adminNavItems,
      ]),
    [pathname]
  )

  // Load saved group choices once, then keep the current page's group open on
  // every navigation so the active link is never folded away.
  useEffect(() => {
    setGroupState(prev => openGroup({ ...readGroupState(), ...prev }, activeGroupId))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only load
  }, [])
  useEffect(() => {
    setGroupState(prev => openGroup(prev, activeGroupId))
  }, [activeGroupId])

  const handleToggleGroup = (id: string, defaultOpen: boolean) => {
    setGroupState(prev => {
      const next = toggleGroup(prev, id, defaultOpen)
      writeGroupState(next)
      return next
    })
  }

  const handleNavigation = (href: string) => {
    if (pathname !== href) {
      setLoadingPath(href)
    }
  }

  // Interim until the per-role rights fetch lands: user/dealer all capabilities, admin all, sub_agent fixed set.
  const rights = interimRightsFor(userRole)

  const visibleMenuItems = menuItems.filter(item => {
    if (!userRole || !navVisible(item, userRole, rights)) return false
    if (item.feature === "standard-bundles") {
      if (!bundlesAvailability?.enabled) return false
    } else if (item.feature && !featureAvailable(billsAvailability, item.feature)) return false
    if (item.href === '/dashboard' && isPageHidden('dashboard_home', domainBranding.hiddenPages)) return false
    // Hide upgrade page for dealers with no subscription end-date (permanent dealers)
    if (item.href === '/dashboard/upgrade' && userRole === 'dealer' && !dealerHasSubscription) return false
    // On a custom domain scoped to one service, hide nav entries for the other services.
    if (!isPathAllowedForService(item.href, domainBranding.services, domainBranding.hiddenPages)) return false
    return true
  })

  const visibleShopItems = shopItems.filter(item =>
    userRole && navVisible(item, userRole, rights) &&
    isPathAllowedForService(item.href, domainBranding.services, domainBranding.hiddenPages)
  )

  const adminBadge = (badge: AdminNavBadge | undefined): Pick<LinkOpts, "badge" | "badgeSuffix" | "badgeTone"> => {
    if (badge === "pendingOrders") return { badge: adminPendingOrderCount, badgeTone: "destructive" }
    if (badge === "whatsappUnread") return { badge: waUnreadCount, badgeSuffix: waUnreadCapped ? "+" : "", badgeTone: "primary" }
    return {}
  }

  const badgeClass = (tone: LinkOpts["badgeTone"]) =>
    tone === "primary"
      ? "bg-primary hover:bg-primary/90 text-primary-foreground text-xs"
      : "bg-destructive hover:bg-destructive text-destructive-foreground text-xs"

  const renderLink = (item: NavLinkItem, opts: LinkOpts) => {
    const Icon = item.icon
    const isLoading = loadingPath === item.href
    const showNew = isNew(item.href)
    const badge = opts.badge ?? 0
    const showBadge = badge > 0

    return (
      <Link
        key={item.href}
        href={item.href}
        className="block"
        onClick={() => { markClicked(item.href); handleNavigation(item.href) }}
      >
        <Button
          variant="ghost"
          className={cn(
            "relative w-full justify-start gap-3 transition-all duration-200",
            opts.active ? c.navLinkActive : c.navLinkInactive,
            !isOpen && "justify-center",
            isLoading && "opacity-70"
          )}
          title={!isOpen ? item.label : undefined}
          aria-current={opts.active ? "page" : undefined}
          disabled={isLoading}
          data-tour={opts.tour}
        >
          {isLoading ? (
            <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
          ) : (
            <Icon className="w-5 h-5 flex-shrink-0" />
          )}
          {isOpen && (
            <span className="flex items-center justify-between flex-1 min-w-0 gap-2">
              <span className="truncate">{item.label}</span>
              {(showNew || showBadge) && (
                <span className="flex items-center gap-1.5 shrink-0">
                  {showNew && <NewTag />}
                  {showBadge && (
                    <Badge className={badgeClass(opts.badgeTone)}>
                      {formatCount(badge)}{opts.badgeSuffix ?? ""}
                    </Badge>
                  )}
                </span>
              )}
            </span>
          )}
          {!isOpen && showNew && <NewTag compact />}
        </Button>
      </Link>
    )
  }

  /**
   * One block of links. With a group and the sidebar expanded it gets a
   * clickable heading that folds it; a folded heading still shows the item
   * count, a NEW dot and any pending counts so nothing important is hidden.
   * In the collapsed icon rail every group is shown, split by a thin line.
   */
  const renderSection = <T extends NavLinkItem>(
    key: string,
    group: NavGroupDef | null,
    items: T[],
    defaultOpen: boolean,
    linkOpts: (item: T) => LinkOpts,
    withDivider: boolean
  ) => {
    const links = () => <div className="space-y-1">{items.map(i => renderLink(i, linkOpts(i)))}</div>

    if (!group || !isOpen) {
      return (
        <div key={key} className={cn(withDivider && "pt-2 mt-2 border-t", withDivider && c.sectionBorder)}>
          {links()}
        </div>
      )
    }

    const open = isGroupOpen(groupState, group.id, defaultOpen)
    const panelId = `sidebar-group-${group.id}`
    const anyNew = !open && items.some(i => isNew(i.href))
    const badgeTotal = open ? 0 : items.reduce((sum, i) => sum + (linkOpts(i).badge ?? 0), 0)
    const badgeTone = items.map(i => linkOpts(i)).find(o => (o.badge ?? 0) > 0)?.badgeTone

    return (
      <div key={key} className={cn(withDivider && "pt-2 mt-2 border-t", withDivider && c.sectionBorder)}>
        <button
          type="button"
          onClick={() => handleToggleGroup(group.id, defaultOpen)}
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wide",
            "hover:bg-black/5 dark:hover:bg-white/5 transition-colors",
            skin === "admin" && "hover:bg-white/5",
            c.sectionLabelText
          )}
        >
          <span className="flex-1 text-left truncate">{group.label}</span>
          {!open && (
            <span className="flex items-center gap-1.5 shrink-0 normal-case tracking-normal font-normal">
              {anyNew && <NewTag compact />}
              {badgeTotal > 0 && (
                <Badge className={badgeClass(badgeTone)}>{formatCount(badgeTotal)}</Badge>
              )}
              <span className="opacity-70">{items.length}</span>
            </span>
          )}
          <ChevronDown
            className={cn("w-4 h-4 shrink-0 transition-transform duration-200", !open && "-rotate-90")}
            aria-hidden
          />
        </button>
        {open && <div id={panelId} className="mt-1">{links()}</div>}
      </div>
    )
  }

  const menuSections = groupNavItems(visibleMenuItems, menuGroups)
  const adminSections = groupNavItems(adminNavItems, adminNavGroups)

  return (
    <>
      {/* Mobile Toggle Button */}
      {isMobile && (
        <Button
          onClick={() => setIsOpen(!isOpen)}
          variant="ghost"
          size="icon"
          className={cn(
            "fixed left-4 z-50 md:hidden bg-primary text-primary-foreground hover:bg-primary/90 transition-opacity duration-300",
            isOpen && "opacity-0 pointer-events-none"
          )}
          // Centred in the h-14 header, below the iOS status bar when the app
          // runs from the home screen (black-translucent + viewport-fit=cover).
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 1.125rem)" }}
        >
          <Menu className="w-5 h-5" />
        </Button>
      )}

      {/* Overlay for mobile -- blurs the page behind the open drawer
          instead of dimming it with a flat color wash */}
      {isMobile && isOpen && (
        <div
          className="fixed inset-0 z-40 backdrop-blur-sm bg-background/20 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          "h-screen flex flex-col fixed left-0 top-0 z-40 transition-all duration-300 ease-in-out",
          c.container,
          isOpen ? "w-64" : "w-20",
          isMobile && !isOpen && "-translate-x-full"
        )}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        {/* Logo Section */}
        <div className={cn(
          "p-6 border-b",
          c.logoSectionBorder
        )}>
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="bg-card p-2 rounded-xl clay-sm flex-shrink-0 relative">
              <img
                src={domainBranding.logoUrl || "/favicon-v2.jpeg"}
                alt={domainBranding.siteName ? `${domainBranding.siteName} Logo` : "DATAGOD Logo"}
                className="w-6 h-6 rounded-lg object-cover"
              />
              {userRole === 'dealer' && (
                <div className="absolute -top-3 -right-3 rotate-12">
                  <Crown className="w-5 h-5 text-brand-accent fill-brand-accent/80 drop-shadow-md" />
                </div>
              )}
            </div>
            {isOpen && (
              <div>
                <h1 className="text-xl font-bold">{domainBranding.siteName || "DATAGOD"}</h1>
                <p className={cn(
                  "text-xs",
                  c.userIdentityText
                )}>{user?.email || "User"}</p>
              </div>
            )}
          </Link>
        </div>

        {/* Collapse Button */}
        {!isMobile && (
          <div className="px-4 pt-2">
            <Button
              onClick={() => setIsOpen(!isOpen)}
              variant="ghost"
              size="icon"
              className={cn(
                "w-full flex justify-center",
                c.collapseButtonHover
              )}
              title={isOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {isOpen ? (
                <ChevronLeft className="w-5 h-5" />
              ) : (
                <ChevronRight className="w-5 h-5" />
              )}
            </Button>
          </div>
        )}

        {/* Navigation Menu */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-1 scrollbar-thin scrollbar-thumb-primary/40 scrollbar-track-primary/10 hover:scrollbar-thumb-primary/60">
          {roleLoading ? (
            // Show loading skeleton while fetching role
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className={cn("h-10 rounded animate-pulse", skin === 'admin' ? "bg-white/10" : "bg-muted")} />
              ))}
            </div>
          ) : (
            <>
              {/* Main menu: Dashboard, then Buy / Orders & Money / Account */}
              {menuSections.map((section, idx) =>
                renderSection(
                  `menu-${section.group?.id ?? "top"}`,
                  section.group,
                  section.items,
                  false, // groups start closed; the current page's group auto-opens
                  item => ({
                    active: isNavActive(pathname, item.href),
                    badge: item.href === "/dashboard/my-orders" ? userPendingOrderCount : undefined,
                    badgeTone: "destructive",
                    tour: item.label === "Wallet" ? "wallet-topup" : undefined,
                  }),
                  idx > 0 && !isOpen
                )
              )}

              {/* Shop */}
              {visibleShopItems.length > 0 && (
                <div className={cn("pt-3 mt-3 border-t", c.sectionBorder)}>
                  {renderSection(
                    "shop",
                    SHOP_GROUP,
                    visibleShopItems,
                    false,
                    item => ({ active: isNavActive(pathname, item.href) }),
                    false
                  )}
                </div>
              )}
            </>
          )}

          {/* Admin */}
          {isAdmin && (
            <div className={cn("pt-3 mt-3 border-t", c.sectionBorder)}>
              {isOpen && (
                <p className={cn("text-[10px] font-bold tracking-widest px-3 mb-1 opacity-70", c.sectionLabelText)}>
                  ADMIN
                </p>
              )}
              {adminSections.map((section, idx) =>
                renderSection(
                  `admin-${section.group?.id ?? "top"}`,
                  section.group,
                  section.items,
                  false,
                  item => ({ active: pathname === item.href, ...adminBadge(item.badge) }),
                  idx > 0 && !isOpen
                )
              )}
            </div>
          )}
        </nav>

        {/* Community & Logout */}
        <div className={cn(
          "p-4 pb-24 md:pb-4 border-t space-y-2",
          c.sectionBorder
        )}>
          {joinCommunityLink && (
            <Button
              variant="ghost"
              className={cn(
                "w-full justify-start gap-3 text-success-foreground bg-success hover:bg-success/90",
                !isOpen && "justify-center"
              )}
              asChild
              title={!isOpen ? "Join Community" : undefined}
            >
              <a href={joinCommunityLink} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-5 h-5 flex-shrink-0" />
                {isOpen && "Join Community"}
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            className={cn(
              "w-full justify-start gap-3",
              c.logoutText,
              !isOpen && "justify-center"
            )}
            onClick={handleLogout}
            title={!isOpen ? "Logout" : undefined}
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            {isOpen && "Logout"}
          </Button>
        </div>
      </div>
    </>
  )
}
