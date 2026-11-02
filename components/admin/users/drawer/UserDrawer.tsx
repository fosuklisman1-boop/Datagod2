"use client"

import { useEffect, useState } from "react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft } from "lucide-react"
import { userApiPath } from "@/lib/admin-users/drawer-client"
import { LoadState, useAdminGet } from "./shared"
import { ProfileTab } from "./ProfileTab"
import { OrdersTab } from "./OrdersTab"
import { WalletTab } from "./WalletTab"
import { ShopTab } from "./ShopTab"
import { HistoryTab } from "./HistoryTab"
import type { DrawerProfile } from "./types"

const TABS = [
  ["profile", "Profile"],
  ["orders", "Orders"],
  ["wallet", "Wallet"],
  ["shop", "Shop"],
  ["history", "Admin history"],
] as const
type Tab = (typeof TABS)[number][0]

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
  /** Bumped by the page after one of its dialogs changed this user: the drawer reloads. */
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
 * back does not refetch). Sub-agents and parent shops open in the same drawer, with a Back button.
 */
export default function UserDrawer(props: UserDrawerProps) {
  const { open, onOpenChange } = props
  // Users opened from the Shop tab stack on top of the one opened from the list.
  const [stack, setStack] = useState<string[]>([])
  useEffect(() => {
    if (open && props.userId) setStack([props.userId])
  }, [open, props.userId])
  const userId = stack[stack.length - 1] ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 gap-0 overflow-y-auto">
        {open && userId && (
          <DrawerBody
            key={`${userId}:${props.refreshToken}`}
            {...props}
            userId={userId}
            canGoBack={stack.length > 1}
            onBack={() => setStack((s) => s.slice(0, -1))}
            onOpenUser={(id) => setStack((s) => (s[s.length - 1] === id ? s : [...s, id]))}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function DrawerBody(props: UserDrawerProps & { userId: string; canGoBack: boolean; onBack: () => void; onOpenUser: (id: string) => void }) {
  const { userId } = props
  const [tab, setTab] = useState<Tab>("profile")
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(["profile"]))
  const [reload, setReload] = useState(0)
  const profile = useAdminGet<DrawerProfile>(userApiPath(userId, "profile"))
  const p = profile.data

  const ref = (): DrawerUserRef | null =>
    p ? { id: p.id, email: p.email, walletBalance: p.walletBalance, is_suspended: p.isSuspended } : null
  const call = (fn: (u: DrawerUserRef) => void) => () => { const r = ref(); if (r) fn(r) }

  const changed = () => {
    profile.reload()
    setReload((n) => n + 1)
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
          setTab(v as Tab)
          setVisited((s) => (s.has(v as Tab) ? s : new Set(s).add(v as Tab)))
        }}
        className="p-4"
      >
        <TabsList className="grid w-full grid-cols-5 h-auto">
          {TABS.map(([value, label]) => (
            <TabsTrigger key={value} value={value} className="text-xs sm:text-sm px-1 whitespace-normal">{label}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <LoadState loading={profile.loading && !p} error={profile.error} onRetry={profile.reload}>
            {p && (
              <ProfileTab
                profile={p}
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
            <OrdersTab userId={userId} />
          </TabsContent>
        )}
        {visited.has("wallet") && (
          <TabsContent value="wallet" forceMount className="mt-4 data-[state=inactive]:hidden">
            <WalletTab
              key={reload}
              userId={userId}
              onAdjust={(balance) => { const r = ref(); if (r) props.onAdjustWallet({ ...r, walletBalance: balance }) }}
            />
          </TabsContent>
        )}
        {visited.has("shop") && (
          <TabsContent value="shop" forceMount className="mt-4 data-[state=inactive]:hidden">
            <ShopTab userId={userId} onOpenUser={props.onOpenUser} />
          </TabsContent>
        )}
        {visited.has("history") && (
          <TabsContent value="history" forceMount className="mt-4 data-[state=inactive]:hidden">
            <HistoryTab key={reload} userId={userId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
