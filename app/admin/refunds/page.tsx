"use client"
/* eslint-disable @typescript-eslint/no-explicit-any -- untrusted JSON rows */

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { supabase } from "@/lib/supabase"
import { useAdminProtected } from "@/hooks/use-admin"
import { RefundDialog } from "@/components/admin/refunds/refund-dialog"
import { OtpDialog } from "@/components/admin/refunds/otp-dialog"
import { SettleFailedDialog } from "@/components/admin/refunds/settle-failed-dialog"
import { postRefundAction } from "@/components/admin/refunds/api"
import { ATTENTION_STATUSES, isAttentionStatus, type RefundAction, type RefundOutcome, type SettleFailedDetail } from "@/lib/refunds/ui-outcome"

interface PendingRow {
  order: {
    table: string; id: string; shopName: string | null; packageLabel: string; network: string
    recipientPhone: string | null; createdAt: string; paid: number; gatewayFee: number
    payment: { gateway: string | null; payerPhone: string | null }
    owners: { shopId: string; credited: number; pending: number }[]
  }
  eligibility: { eligible: true } | { eligible: false; code?: string; reason: string }
  defaultAmount: number
}

type RefundStatus = "reserved" | "processing" | "awaiting_otp" | "completed" | "failed"

interface HistoryRow {
  id: string; order_table: string; order_id: string; gateway: string; amount: number
  status: RefundStatus; error: string | null; gateway_ref: string | null
  created_at: string; late_events: unknown[] | null
}

type StatusFilter = "all" | "attention" | "completed" | "failed"

const TABLE_LABEL: Record<string, string> = { shop_orders: "Storefront", ussd_orders: "USSD", ussd_shop_orders: "USSD shop" }
const PAGE_SIZE = 50

const ATTENTION_HINT: Record<string, string> = {
  reserved: "Stuck after a crash. The payout may have gone out. Check status before doing anything else.",
  processing: "Awaiting gateway confirmation. Check status.",
  awaiting_otp: "Waiting for the payout OTP. Enter it, check status, or cancel.",
}

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

async function getJson(path: string, token: string): Promise<{ rows: any[] }> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(res.status === 403 ? "Sign in as an admin" : json.error || "Failed to load")
  return json
}

function Pager({ page, count, loading, onPage }: { page: number; count: number; loading: boolean; onPage: (p: number) => void }) {
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-muted-foreground">Page {page}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={loading || count < PAGE_SIZE} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  )
}

export default function AdminRefundsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [pending, setPending] = useState<PendingRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")
  const [appliedQ, setAppliedQ] = useState("")
  const [pendingPage, setPendingPage] = useState(1)
  const [historyPage, setHistoryPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [target, setTarget] = useState<{ table: string; id: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [otpFor, setOtpFor] = useState<string | null>(null)
  const [otp, setOtp] = useState("")
  const [otpMessage, setOtpMessage] = useState<string | null>(null)
  const [cancelFor, setCancelFor] = useState<string | null>(null)
  const [settleFailed, setSettleFailed] = useState<{ message: string; detail: SettleFailedDetail } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const hq = (extra: string) => `/api/admin/refunds/history?${extra}`
      const [p, h] = await Promise.all([
        getJson(`/api/admin/refunds/pending?q=${encodeURIComponent(appliedQ)}&page=${pendingPage}`, token),
        statusFilter === "attention"
          // "Needs attention" = 3 history calls (one per status; the route filters by a single status),
          // merged newest-first. These states are rare so they are not paged.
          ? Promise.all(ATTENTION_STATUSES.map((s) => getJson(hq(`status=${s}`), token))).then((rs) =>
              rs.flatMap((r) => r.rows as HistoryRow[]).sort((a, b) => b.created_at.localeCompare(a.created_at)))
          : getJson(hq(`page=${historyPage}${statusFilter === "all" ? "" : `&status=${statusFilter}`}`), token).then((r) => r.rows as HistoryRow[]),
      ])
      setPending(p.rows)
      setHistory(h)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load refunds")
    } finally {
      setLoading(false)
    }
  }, [appliedQ, pendingPage, historyPage, statusFilter])

  useEffect(() => { if (isAdmin) void load() }, [isAdmin, load])

  const handleOutcome = useCallback((o: RefundOutcome) => {
    switch (o.kind) {
      case "success": toast.success(o.message); break
      case "info": toast.info(o.message); break
      case "warning": toast.warning(o.message); break
      case "payout_failed": toast.error(o.message); break
      case "auth": toast.error(o.message); break
      case "error": toast.error(o.message); break
      case "settle_failed": setSettleFailed({ message: o.message, detail: o.detail }); break
      case "awaiting_otp":
        if (o.refundId) { setOtp(""); setOtpMessage(o.wrongOtp ? o.message : null); setOtpFor(o.refundId) }
        toast.info(o.message)
        break
    }
  }, [])

  const act = async (id: string, action: Exclude<RefundAction, "execute">, body: Record<string, unknown> = {}) => {
    if (busyId) return
    setBusyId(id)
    try {
      const o = await postRefundAction(await getToken(), `/api/admin/refunds/${id}/${action}`, action, body)
      if (action === "otp" && o.kind === "awaiting_otp") {
        // Wrong code: keep the OTP dialog open, show the message, clear the input.
        setOtp("")
        setOtpMessage(o.message)
        return
      }
      if (action === "otp") { setOtpFor(null); setOtp(""); setOtpMessage(null) }
      handleOutcome(o)
      await load()
    } finally {
      setBusyId(null)
    }
  }

  if (adminLoading || !isAdmin) return null

  const applySearch = () => { setPendingPage(1); setAppliedQ(q.trim()) }

  return (
    <DashboardLayout>
      <PageHeaderBanner title="Refunds" subtitle="Refund paid orders that have not been delivered" />
      <Tabs defaultValue="pending" className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="pending">Pending orders</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <div className="flex gap-2">
            <Input placeholder="Search phone or order id" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applySearch()} className="w-56" />
            <Button variant="outline" size="icon" onClick={() => (q.trim() !== appliedQ ? applySearch() : void load())} disabled={loading} aria-label="Refresh">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <TabsContent value="pending">
          <Card>
            <CardHeader><CardTitle>Pending, paid orders</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead><TableHead>Shop</TableHead><TableHead>Package</TableHead>
                    <TableHead>Recipient</TableHead><TableHead>Paid</TableHead><TableHead>Paid via</TableHead>
                    <TableHead>Owner cut</TableHead><TableHead>Placed</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map(({ order, eligibility }) => (
                    <TableRow key={`${order.table}:${order.id}`} className={eligibility.eligible ? "" : "opacity-60"}>
                      <TableCell>{TABLE_LABEL[order.table] ?? order.table}</TableCell>
                      <TableCell>{order.shopName ?? "-"}</TableCell>
                      <TableCell>{order.packageLabel} {order.network}</TableCell>
                      <TableCell>{order.recipientPhone ?? "-"}</TableCell>
                      <TableCell>GHS {order.paid.toFixed(2)}</TableCell>
                      <TableCell>{order.payment.gateway ?? "unknown"}</TableCell>
                      <TableCell>{order.owners.length ? `GHS ${order.owners.reduce((s, o) => s + o.credited + o.pending, 0).toFixed(2)}` : "-"}</TableCell>
                      <TableCell>{new Date(order.createdAt).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {eligibility.eligible ? (
                          <Button size="sm" onClick={() => setTarget({ table: order.table, id: order.id })}>Refund</Button>
                        ) : (
                          <span className="text-xs text-muted-foreground" title={eligibility.reason}>{eligibility.reason}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!loading && pending.length === 0 && (
                    <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No pending paid orders.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              <Pager page={pendingPage} count={pending.length} loading={loading} onPage={setPendingPage} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>Refund history</CardTitle>
              <div className="flex gap-1" role="group" aria-label="Status filter">
                {(["all", "attention", "completed", "failed"] as StatusFilter[]).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant={statusFilter === f ? "default" : "outline"}
                    disabled={loading}
                    onClick={() => { setHistoryPage(1); setStatusFilter(f) }}
                  >
                    {f === "all" ? "All" : f === "attention" ? "Needs attention" : f === "completed" ? "Completed" : "Failed"}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead><TableHead>Type</TableHead><TableHead>Gateway</TableHead>
                    <TableHead>Amount</TableHead><TableHead>Status</TableHead><TableHead>Notes</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((r) => {
                    const attention = isAttentionStatus(r.status)
                    const busy = busyId !== null
                    return (
                      <TableRow key={r.id} className={attention ? "bg-destructive/5" : ""}>
                        <TableCell>{new Date(r.created_at).toLocaleString()}</TableCell>
                        <TableCell>{TABLE_LABEL[r.order_table] ?? r.order_table}</TableCell>
                        <TableCell>{r.gateway}</TableCell>
                        <TableCell>GHS {Number(r.amount).toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge variant={r.status === "completed" ? "secondary" : attention || r.status === "failed" ? "destructive" : "outline"}>{r.status}</Badge>
                          {attention && <div className="mt-1 text-xs font-medium text-destructive">Needs attention</div>}
                          {(r.late_events?.length ?? 0) > 0 && <Badge variant="destructive" className="ml-1">late update blocked</Badge>}
                        </TableCell>
                        <TableCell className="max-w-xs text-xs" title={r.error ?? ""}>
                          {attention && <div className="text-destructive">{ATTENTION_HINT[r.status]}</div>}
                          {r.error && <div className="truncate">{r.error}</div>}
                          {r.gateway_ref && <div className="truncate font-mono text-muted-foreground">{r.gateway_ref}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            {attention && (
                              <Button size="sm" variant="outline" disabled={busy} onClick={() => act(r.id, "reconcile")}>Check status</Button>
                            )}
                            {r.status === "awaiting_otp" && (
                              <>
                                <Button size="sm" disabled={busy} onClick={() => { setOtp(""); setOtpMessage(null); setOtpFor(r.id) }}>Enter OTP</Button>
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelFor(r.id)}>Cancel refund</Button>
                              </>
                            )}
                            {r.status === "failed" && (
                              <Button size="sm" variant="outline" disabled={busy} onClick={() => act(r.id, "retry")}>Retry</Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {!loading && history.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No refunds found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              {statusFilter !== "attention" && (
                <Pager page={historyPage} count={history.length} loading={loading} onPage={setHistoryPage} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RefundDialog target={target} getToken={getToken} onClose={() => setTarget(null)} onOutcome={(o) => { handleOutcome(o); void load() }} />

      <OtpDialog
        open={!!otpFor}
        otp={otp}
        message={otpMessage}
        busy={busyId !== null}
        onChange={setOtp}
        onSubmit={() => otpFor && act(otpFor, "otp", { otp: otp.trim() })}
        onClose={() => { setOtpFor(null); setOtpMessage(null) }}
      />

      <SettleFailedDialog info={settleFailed} onAcknowledge={() => setSettleFailed(null)} />

      <AlertDialog open={!!cancelFor} onOpenChange={(o) => !o && busyId === null && setCancelFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this refund?</AlertDialogTitle>
            <AlertDialogDescription>
              The payout has not been released. Cancelling restores the shop owner&apos;s cut and the order returns to pending. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>Keep refund</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyId !== null}
              onClick={(e) => {
                e.preventDefault()
                const id = cancelFor
                if (id) void act(id, "cancel").then(() => setCancelFor(null))
              }}
            >
              {busyId !== null ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Cancel refund
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}
