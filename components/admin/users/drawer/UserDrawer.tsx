"use client"

import { useState } from "react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft } from "lucide-react"
import { userApiPath } from "@/lib/admin-users/drawer-client"
import { back, current, openRoot, push, setTab, type DrawerStack, type DrawerTab } from "@/lib/admin-users/drawer-stack"
import { LoadState, useAdminGet } from "./shared"
import { ProfileTab } from "./ProfileTab"
import { OrdersTab } from "./OrdersTab"
import { WalletTab } from "./WalletTab"
import { ShopTab } from "./ShopTab"
import { HistoryTab } from "./HistoryTab"
import { NotesTab } from "./NotesTab"
import type { DrawerProfile } from "./types"

const TAB_LABELS: Array<[DrawerTab, string]> = [
  ["profile", "Profile"],
  ["orders", "Orders"],
  ["wallet", "Wallet"],
  ["shop", "Shop"],
  ["notes", "Notes"],
  ["history", "Admin history"],
]

/** What the page's dialogs need about the user the drawer is showing. */
export interface DrawerUserRef {
  id: string
  email: string
  walletBalance: number
  is_suspended: boolean
}

export interface UserDrawerProps {
  userId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Bumped by the page after one of its dialogs changed this user: the drawer reloads its data in place. */
  refreshToken: number
  /** A change was made from inside the drawer: the page reloads its list. */
  onChanged: () => void
  onAdjustWallet: (user: DrawerUserRef) => void
  onChangePassword: (user: DrawerUserRef) => void
  onAccountActions: (user: DrawerUserRef) => void
  onCustomPrices: (user: DrawerUserRef) => void
}

/**
 * Side drawer with a user's profile, orders, wallet ledger, shop and admin history. Nothing loads until it is
 * open, and each tab fetches its own data only the first time it is shown (then stays mounted, so switching
 * back does not refetch). Sub-agents and parent shops open on a stack in the same drawer; each stack entry keeps
 * its tab, so Back returns to the tab you came from.
 */
export default function UserDrawer(props: UserDrawerProps) {
  const { open, onOpenChange, userId } = props
  const [stack, setStack] = useState<DrawerStack>(() => (open && userId ? openRoot(userId) : []))
  // Reset the stack while rendering (not in an effect) when the drawer opens or is pointed at another user, so the
  // previous user is never painted, not even for one frame.
  const [seen, setSeen] = useState<{ open: boolean; userId: string | null }>({ open, userId })
  if (seen.open !== open || seen.userId !== userId) {
    setSeen({ open, userId })
    if (open && userId) setStack(openRoot(userId))
  }
  const top = current(stack)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 gap-0 overflow-y-auto">
        {open && top && (
          <DrawerBody
            // One body per stack entry: going Back remounts the previous user's body on its saved tab.
            key={`${stack.length}:${top.userId}`}
            {...props}
            userId={top.userId}
            tab={top.tab}
            onTab={(t) => setStack((s) => setTab(s, t))}
            canGoBack={stack.length > 1}
            onBack={() => setStack(back)}
            onOpenUser={(id) => setStack((s) => push(s, id))}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function DrawerBody(props: UserDrawerProps & {
  userId: string
  tab: DrawerTab
  onTab: (tab: DrawerTab) => void
  canGoBack: boolean
  onBack: () => void
  onOpenUser: (id: string) => void
}) {
  const { userId, tab } = props
  const [visited, setVisited] = useState<Set<DrawerTab>>(() => new Set<DrawerTab>(["profile", tab]))
  // Bumped by changes made from inside the drawer; added to the page's refreshToken so every tab reloads in place.
  const [localRefresh, setLocalRefresh] = useState(0)
  const refreshKey = props.refreshToken + localRefresh
  const profile = useAdminGet<DrawerProfile>(userApiPath(userId, "profile"), refreshKey)
  const p = profile.data

  const ref = (): DrawerUserRef | null =>
    p ? { id: p.id, email: p.email, walletBalance: p.walletBalance, is_suspended: p.isSuspended } : null
  const call = (fn: (u: DrawerUserRef) => void) => () => { const r = ref(); if (r) fn(r) }

  const changed = () => {
    setLocalRefresh((n) => n + 1)
    props.onChanged()
  }

  return (
    <div className="flex flex-col min-h-full">
      <SheetHeader className="border-b p-4 pr-12">
        <div className="flex items-center gap-2">
          {props.canGoBack && (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={props.onBack} aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          )}
          <SheetTitle className="truncate">{p?.email || "User"}</SheetTitle>
          {p?.isSuspended && <Badge className="bg-destructive">suspended</Badge>}
        </div>
        <SheetDescription className="text-xs break-all">
          {p ? [p.role, p.phoneNumber, userId].filter(Boolean).join(" · ") : userId}
        </SheetDescription>
      </SheetHeader>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          const t = v as DrawerTab
          props.onTab(t)
          setVisited((s) => (s.has(t) ? s : new Set(s).add(t)))
        }}
        className="p-4"
      >
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-6 h-auto">
          {TAB_LABELS.map(([value, label]) => (
            <TabsTrigger key={value} value={value} className="text-xs sm:text-sm px-1 whitespace-normal">{label}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <LoadState loading={profile.loading && !p} error={profile.error} onRetry={profile.reload}>
            {p && (
              <ProfileTab
                profile={p}
                refreshKey={refreshKey}
                onChanged={changed}
                actions={{
                  onAdjustWallet: call(props.onAdjustWallet),
                  onChangePassword: call(props.onChangePassword),
                  onAccountActions: call(props.onAccountActions),
                  onCustomPrices: call(props.onCustomPrices),
                }}
              />
            )}
          </LoadState>
        </TabsContent>
        {/* Other tabs mount the first time they are opened (lazy), then stay mounted but hidden. */}
        {visited.has("orders") && (
          <TabsContent value="orders" forceMount className="mt-4 data-[state=inactive]:hidden">
            <OrdersTab userId={userId} refreshKey={refreshKey} />
          </TabsContent>
        )}
        {visited.has("wallet") && (
          <TabsContent value="wallet" forceMount className="mt-4 data-[state=inactive]:hidden">
            <WalletTab
              userId={userId}
              refreshKey={refreshKey}
              onAdjust={(balance) => { const r = ref(); if (r) props.onAdjustWallet({ ...r, walletBalance: balance }) }}
            />
          </TabsContent>
        )}
        {visited.has("shop") && (
          <TabsContent value="shop" forceMount className="mt-4 data-[state=inactive]:hidden">
            <ShopTab userId={userId} refreshKey={refreshKey} onOpenUser={props.onOpenUser} />
          </TabsContent>
        )}
        {visited.has("notes") && (
          <TabsContent value="notes" forceMount className="mt-4 data-[state=inactive]:hidden">
            <NotesTab userId={userId} refreshKey={refreshKey} />
          </TabsContent>
        )}
        {visited.has("history") && (
          <TabsContent value="history" forceMount className="mt-4 data-[state=inactive]:hidden">
            <HistoryTab userId={userId} refreshKey={refreshKey} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
