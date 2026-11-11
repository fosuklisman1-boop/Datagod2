"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { adminErrorMessage, formatGhs } from "@/lib/momo-claim/admin-view"
import { adminFetch, ApiError } from "./api"

type Session = {
  id: string
  code: string
  amount: number
  fee: number
  netAmount: number
  status: string
  createdAt: string
  expiresAt: string
  claimedTransactionId: string | null
}

const API = "/api/admin/momo-claims/sessions"

export function SessionsTab() {
  const [rows, setRows] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await adminFetch<{ sessions: Session[] }>(API)
      setRows(r.sessions)
    } catch (e) {
      setError(adminErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function forceExpire() {
    if (!confirm) return
    setBusy(true)
    try {
      await adminFetch(API, { method: "PATCH", body: { id: confirm.id, action: "force_expire" } })
      toast.success("Session expired")
      setConfirm(null)
      void load()
    } catch (e) {
      toast.error(adminErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Latest 200 payment sessions.</p>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-1 h-4 w-4" />Refresh</Button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Fee</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Claimed transaction</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">{loading ? "Loading..." : "No sessions yet."}</TableCell></TableRow>
            )}
            {rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.code}</TableCell>
                <TableCell className="text-right tabular-nums">{formatGhs(s.amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatGhs(s.fee)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatGhs(s.netAmount)}</TableCell>
                <TableCell className="capitalize">{s.status}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">{new Date(s.createdAt).toLocaleString()}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">{new Date(s.expiresAt).toLocaleString()}</TableCell>
                <TableCell className="font-mono text-xs">{s.claimedTransactionId ?? "-"}</TableCell>
                <TableCell>
                  {s.status === "pending" && <Button size="sm" variant="outline" onClick={() => setConfirm(s)}>Force-expire</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force-expire this session?</AlertDialogTitle>
            <AlertDialogDescription>
              Code {confirm?.code} can no longer be matched to a payment. Use this if the customer asked to cancel or the code leaked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void forceExpire() }} disabled={busy}>Force-expire</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
