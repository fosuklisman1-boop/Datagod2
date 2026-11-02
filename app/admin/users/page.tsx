"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { adminUserService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { CustomPricesDialog } from "@/components/admin/CustomPricesDialog"
import {
  DEFAULT_FILTERS,
  listParamsToSearchParams,
  normaliseSearch,
  readListParamsFromUrl,
  type UserSort,
  type UsersListFilters,
  type UsersListParams,
} from "@/lib/admin-users/list-params"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { createParamsTracker } from "@/lib/admin-users/params-tracker"
import { removeIds, setSelected, setSelectedMany } from "@/lib/admin-users/selection"
import { formatCount, type AdminUser, type DialogUser } from "@/components/admin/users/types"
import { UsersFilters, hasActiveFilters } from "@/components/admin/users/UsersFilters"
import { UsersPagination, UsersTable } from "@/components/admin/users/UsersTable"
import { UsersDownloads } from "@/components/admin/users/UsersDownloads"
import { BalanceDialog } from "@/components/admin/users/BalanceDialog"
import { ChangePasswordDialog } from "@/components/admin/users/ChangePasswordDialog"
import { AccountActionsDialog } from "@/components/admin/users/AccountActionsDialog"

const SEARCH_DEBOUNCE_MS = 300

// The drawer's code is only fetched when a user is first opened; its tabs fetch their data when shown.
const UserDrawer = dynamic(() => import("@/components/admin/users/drawer/UserDrawer"), { ssr: false })

/** Default direction when a column is first clicked: text A→Z, numbers and dates biggest/newest first. */
const firstDir = (s: UserSort) => (s === "email" ? "asc" : "desc")

type DialogKind = "balance" | "password" | "actions"

export default function AdminUsersPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <AdminUsersPageInner />
    </Suspense>
  )
}

function AdminUsersPageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // The URL is the source of truth for filters, sort and page, so reloads and shared links keep them.
  const params = useMemo(() => readListParamsFromUrl(new URLSearchParams(searchParams.toString())), [searchParams])
  const paramsKey = listParamsToSearchParams(params).toString()
  const filters: UsersListFilters = useMemo(() => {
    const { q, role, suspended, hasShop, pricingMode, from, to, sort, dir } = params
    return { q, role, suspended, hasShop, pricingMode, from, to, sort, dir }
  }, [params])
  const filtersKey = listParamsToSearchParams(filters).toString()

  const [isAdmin, setIsAdmin] = useState(false)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  // Search box: typed text is applied to the URL after a pause.
  const [searchInput, setSearchInput] = useState(params.q ?? "")
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS)

  // Selected rows by id. Kept across pages; cleared when the filters change. (Bulk actions build on this.)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  const [selectedUser, setSelectedUser] = useState<DialogUser | null>(null)
  // Independent flags: these dialogs open on top of the user drawer.
  const [openDialogs, setOpenDialogs] = useState<Record<DialogKind, boolean>>({ balance: false, password: false, actions: false })
  // The user drawer: which user, whether it is open, and a token that makes it reload after a dialog changed the user.
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerRefresh, setDrawerRefresh] = useState(0)
  const setDialogOpen = (kind: DialogKind, open: boolean) => setOpenDialogs((d) => ({ ...d, [kind]: open }))
  const [customPricesUser, setCustomPricesUser] = useState<{ id: string; label: string } | null>(null)

  // Every change is applied on top of the last params we asked for, not the URL's (router.replace is
  // async), so the debounced search can't undo a filter clicked just before it fired.
  const trackerRef = useRef(createParamsTracker(params))
  useEffect(() => {
    trackerRef.current.urlChanged(params)
  }, [paramsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const pushParams = useCallback((next: UsersListParams) => {
    const qs = listParamsToSearchParams(next).toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router])

  /** Change filters/sort; goes back to page 1. A reversed date range is swapped. */
  const updateFilters = useCallback((patch: Partial<UsersListFilters>) => {
    pushParams(trackerRef.current.apply(patch))
  }, [pushParams])

  const goToPage = (page: number) => pushParams(trackerRef.current.apply({ page }, { keepPage: true }))

  const loadUsers = useCallback(() => setReloadToken((n) => n + 1), [])

  useEffect(() => {
    checkAdminAccess()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced search -> URL.
  useEffect(() => {
    const q = normaliseSearch(debouncedSearch)
    if (q !== trackerRef.current.current().q) updateFilters({ q })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch])

  // URL changed from outside the box (back/forward, Clear filters): show it in the box.
  const lastUrlQ = useRef(params.q)
  useEffect(() => {
    if (params.q !== lastUrlQ.current) {
      lastUrlQ.current = params.q
      if (normaliseSearch(searchInput) !== params.q) setSearchInput(params.q ?? "")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.q])

  // New filters: forget the selection.
  const firstFilters = useRef(true)
  useEffect(() => {
    if (firstFilters.current) { firstFilters.current = false; return }
    setSelectedIds(new Set())
  }, [filtersKey])

  // Fetch the current page. A newer request aborts an older one, so fast typing can't show stale rows.
  useEffect(() => {
    if (!isAdmin) return
    const ctrl = new AbortController()
    setLoading(true)
    adminUserService.listUsers(params, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        setLoadError(null)
        setUsers(res.users || [])
        setTotal(res.total || 0)
        // Past the last page (e.g. after a delete or a stale link): go to the last page that exists.
        const lastPage = Math.max(1, Math.ceil((res.total || 0) / params.pageSize))
        if ((res.users || []).length === 0 && params.page > lastPage) goToPage(lastPage)
      })
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return
        console.error("Error loading users:", error)
        // Don't leave the previous filters' rows on screen as if they matched.
        setUsers([])
        setTotal(0)
        setLoadError(error instanceof Error ? error.message : "Failed to load users")
        toast.error(error instanceof Error ? error.message : "Failed to load users")
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, paramsKey, reloadToken])

  const checkAdminAccess = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push("/dashboard")
        return
      }

      // First check user_metadata, then fall back to DB (source of truth)
      let isAdminUser = user?.user_metadata?.role === "admin"

      if (!isAdminUser) {
        const { data: userData } = await supabase
          .from("users")
          .select("role")
          .eq("id", user.id)
          .single()
        isAdminUser = userData?.role === "admin"
      }

      if (!isAdminUser) {
        toast.error("Unauthorized access")
        router.push("/dashboard")
        return
      }

      setIsAdmin(true)
    } catch (error) {
      console.error("Error checking admin access:", error)
      router.push("/dashboard")
    }
  }

  const handleSort = (sort: UserSort) => {
    const cur = trackerRef.current.current()
    updateFilters(cur.sort === sort ? { dir: cur.dir === "asc" ? "desc" : "asc" } : { sort, dir: firstDir(sort) })
  }

  const resetFilters = () => {
    setSearchInput("")
    const { sort: _sort, dir: _dir, ...cleared } = DEFAULT_FILTERS
    updateFilters(cleared)
  }

  const toggleSelected = (id: string, selected: boolean) => setSelectedIds((prev) => setSelected(prev, id, selected))
  const toggleAllOnPage = (selected: boolean) => setSelectedIds((prev) => setSelectedMany(prev, users.map((u) => u.id), selected))
  const forgetDeletedUser = (userId: string) => setSelectedIds((prev) => removeIds(prev, [userId]) as Set<string>)

  const openFor = (kind: DialogKind) => (user: DialogUser) => {
    setSelectedUser({ id: user.id, email: user.email, walletBalance: user.walletBalance, is_suspended: user.is_suspended })
    setDialogOpen(kind, true)
  }
  const openDrawer = (user: AdminUser) => {
    setDrawerUserId(user.id)
    setDrawerOpen(true)
  }
  /** A dialog changed a user: reload the list and the drawer. */
  const userChanged = () => {
    loadUsers()
    setDrawerRefresh((n) => n + 1)
  }
  const dialogProps = (kind: DialogKind) => ({
    user: selectedUser,
    open: openDialogs[kind],
    onOpenChange: (open: boolean) => setDialogOpen(kind, open),
  })

  if (!isAdmin) return null

  const filtered = hasActiveFilters(filters)

  return (
    <DashboardLayout>
      <div className="space-y-6 px-2 sm:px-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <PageHeaderBanner
            className="flex-1"
            title="User Management"
            subtitle="Manage user roles, balances, and account status"
          />
          <UsersDownloads filters={filters} />
        </div>

        {/* Users Table */}
        <Card className="bg-card backdrop-blur-xl border border-border">
          <CardHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <CardTitle>{filtered ? "Matching Users" : "All Users"} ({formatCount(total)})</CardTitle>
                  <CardDescription>Manage user roles, balances, and account status</CardDescription>
                </div>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                    <span>{selectedIds.size.toLocaleString()} selected</span>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                      Clear
                    </Button>
                  </div>
                )}
              </div>
              <UsersFilters
                filters={filters}
                searchInput={searchInput}
                onSearchInput={setSearchInput}
                onChange={updateFilters}
                onReset={resetFilters}
              />
            </div>
          </CardHeader>
          <CardContent>
            <UsersTable
              users={users}
              loading={loading}
              error={loadError}
              onRetry={loadUsers}
              filtered={filtered}
              sort={params.sort}
              dir={params.dir}
              onSort={handleSort}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onToggleAllOnPage={toggleAllOnPage}
              onView={openDrawer}
              onBalance={openFor("balance")}
              onAccountActions={openFor("actions")}
              onCustomPrices={(user) => setCustomPricesUser({ id: user.id, label: user.email ?? user.id })}
            />
            <UsersPagination
              page={params.page}
              pageSize={params.pageSize}
              total={total}
              loading={loading}
              onPage={goToPage}
            />
          </CardContent>
        </Card>

        {drawerUserId && (
          <UserDrawer
            userId={drawerUserId}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            refreshToken={drawerRefresh}
            onChanged={loadUsers}
            onAdjustWallet={openFor("balance")}
            onChangePassword={openFor("password")}
            onAccountActions={openFor("actions")}
            onCustomPrices={(user) => setCustomPricesUser({ id: user.id, label: user.email || user.id })}
          />
        )}

        <CustomPricesDialog
          userId={customPricesUser?.id ?? null}
          userLabel={customPricesUser?.label ?? ""}
          open={!!customPricesUser}
          onOpenChange={(o) => { if (!o) setCustomPricesUser(null) }}
          onSaved={(mode) => {
            setUsers((list) => list.map((u) => (u.id === customPricesUser?.id ? { ...u, pricing_mode: mode } : u)))
            setDrawerRefresh((n) => n + 1)
          }}
        />

        <BalanceDialog {...dialogProps("balance")} onChanged={userChanged} />
        <ChangePasswordDialog {...dialogProps("password")} />
        <AccountActionsDialog
          {...dialogProps("actions")}
          onChanged={userChanged}
          onDeleted={(userId) => {
            forgetDeletedUser(userId)
            setDrawerOpen(false)
          }}
        />
      </div>
    </DashboardLayout>
  )
}
