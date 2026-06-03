"use client"

import { useCallback, useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Loader2, Trash2, AlertTriangle, PhoneOff, ShieldAlert, PhoneMissed } from "lucide-react"

type Bucket = "missing" | "invalid" | "unverified"

interface AuditUser {
  id: string
  email: string | null
  phone_number: string | null
  phone_verified: boolean | null
  created_at: string
  bucket: Bucket
  wallet_balance: number
  order_count: number
}

interface AuditResponse {
  bucket: Bucket
  page: number
  pages: number
  total: number
  counts: { missing: number; invalid: number; unverified: number; total: number }
  hasVerifiedColumn: boolean
  users: AuditUser[]
}

const BUCKET_META: Record<Bucket, { label: string; icon: any; hint: string }> = {
  missing: { label: "No phone", icon: PhoneOff, hint: "Accounts with no phone number at all." },
  invalid: { label: "Invalid number", icon: PhoneMissed, hint: "Number doesn't match Ghana mobile format." },
  unverified: { label: "Unverified", icon: ShieldAlert, hint: "Has a valid number but never passed OTP." },
}

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function UserPhoneAuditPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [bucket, setBucket] = useState<Bucket>("missing")
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AuditResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmTargets, setConfirmTargets] = useState<AuditUser[] | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (b: Bucket, p: number) => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/users/phone-audit?bucket=${b}&page=${p}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to load")
      setData(json)
      setSelected(new Set())
    } catch (e: any) {
      toast.error(e.message || "Failed to load audit")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin && !adminLoading) load(bucket, page)
  }, [isAdmin, adminLoading, bucket, page, load])

  const hasHistory = (u: AuditUser) => u.wallet_balance > 0 || u.order_count > 0

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selectedUsers = (data?.users || []).filter((u) => selected.has(u.id))

  const runDelete = async (targets: AuditUser[]) => {
    setDeleting(true)
    let ok = 0
    let fail = 0
    try {
      const token = await getToken()
      for (const u of targets) {
        try {
          const res = await fetch("/api/admin/remove-user", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ userId: u.id }),
          })
          if (res.ok) ok++
          else fail++
        } catch {
          fail++
        }
      }
      if (ok) toast.success(`Deleted ${ok} account${ok > 1 ? "s" : ""}`)
      if (fail) toast.error(`Failed to delete ${fail} account${fail > 1 ? "s" : ""}`)
    } finally {
      setDeleting(false)
      setConfirmTargets(null)
      await load(bucket, page)
    }
  }

  if (adminLoading) return null

  const withHistoryCount = (confirmTargets || []).filter(hasHistory).length

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <PhoneOff className="w-6 h-6" /> User Phone Audit
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Accounts with no phone, an invalid (non-Ghana) number, or an unverified number.
            Deleting is permanent and cascades all of the account&apos;s data.
          </p>
        </div>

        {/* Bucket tabs */}
        <div className="flex gap-0 border-b border-border flex-wrap">
          {(Object.keys(BUCKET_META) as Bucket[]).map((b) => {
            const Icon = BUCKET_META[b].icon
            const count = data?.counts?.[b]
            return (
              <button
                key={b}
                onClick={() => { setBucket(b); setPage(1) }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                  bucket === b ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="w-4 h-4" />
                {BUCKET_META[b].label}
                {typeof count === "number" && <Badge variant="secondary">{count.toLocaleString()}</Badge>}
              </button>
            )
          })}
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm">{BUCKET_META[bucket].hint}</CardTitle>
            {selected.size > 0 && (
              <Button variant="destructive" size="sm" onClick={() => setConfirmTargets(selectedUsers)} disabled={deleting}>
                <Trash2 className="w-4 h-4 mr-1" /> Delete selected ({selected.size})
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></div>
            ) : !data || data.users.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-10">No accounts in this bucket. 🎉</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-3">
                          <input
                            type="checkbox"
                            aria-label="Select all"
                            checked={selected.size === data.users.length && data.users.length > 0}
                            onChange={(e) => setSelected(e.target.checked ? new Set(data.users.map((u) => u.id)) : new Set())}
                          />
                        </th>
                        <th className="pb-2 pr-4">Email</th>
                        <th className="pb-2 pr-4">Phone</th>
                        <th className="pb-2 pr-4">Joined</th>
                        <th className="pb-2 pr-4 text-right">Wallet</th>
                        <th className="pb-2 pr-4 text-center">Orders</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.users.map((u) => (
                        <tr key={u.id} className="border-b last:border-0">
                          <td className="py-2 pr-3">
                            <input type="checkbox" aria-label={`Select ${u.email}`} checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                          </td>
                          <td className="py-2 pr-4 max-w-[220px] truncate">{u.email ?? "—"}</td>
                          <td className="py-2 pr-4 font-mono">{u.phone_number || <span className="text-muted-foreground">none</span>}</td>
                          <td className="py-2 pr-4 text-muted-foreground text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                          <td className="py-2 pr-4 text-right">
                            {u.wallet_balance > 0
                              ? <span className="text-amber-600 dark:text-amber-400 font-medium">GH¢{u.wallet_balance.toFixed(2)}</span>
                              : <span className="text-muted-foreground">0</span>}
                          </td>
                          <td className="py-2 pr-4 text-center">
                            {u.order_count > 0
                              ? <span className="text-amber-600 dark:text-amber-400 font-medium">{u.order_count}</span>
                              : <span className="text-muted-foreground">0</span>}
                          </td>
                          <td className="py-2 text-right">
                            <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => setConfirmTargets([u])} disabled={deleting}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.pages > 1 && (
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-muted-foreground">Page {data.page} of {data.pages} ({data.total.toLocaleString()} accounts)</span>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                      <Button variant="outline" size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Delete confirmation */}
      <Dialog open={!!confirmTargets} onOpenChange={(o) => { if (!o) setConfirmTargets(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" /> Delete {confirmTargets?.length} account{(confirmTargets?.length || 0) > 1 ? "s" : ""}?
            </DialogTitle>
            <DialogDescription>
              This permanently removes the account{(confirmTargets?.length || 0) > 1 ? "s" : ""} and all associated
              data (wallet, orders, shops). This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {withHistoryCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                <strong>{withHistoryCount}</strong> of these {(confirmTargets?.length || 0) > 1 ? "accounts have" : "account has"} a
                wallet balance or past orders — likely a real customer who simply hasn&apos;t added/verified a phone.
                Double-check before deleting.
              </span>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTargets(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={() => confirmTargets && runDelete(confirmTargets)} disabled={deleting}>
              {deleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {deleting ? "Deleting..." : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
