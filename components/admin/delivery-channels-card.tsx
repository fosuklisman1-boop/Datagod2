"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Loader2, Timer } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface ChannelRow { channel: string; label: string; isManuallyDown: boolean; reason: string | null; since: string | null }

async function authed(path: string, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("Not signed in")
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` } })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || res.statusText)
  return json
}

/**
 * Manual "mark this channel down" for the live delivery estimate. While down, the dashboard freezes that
 * channel's last numbers, shows 0% and "Experiencing delays", and confirmation screens show no estimate.
 * Selling is not affected (use Network Stock Status for that).
 */
export function DeliveryChannelsCard() {
  const [rows, setRows] = useState<ChannelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ChannelRow | null>(null)
  const [reason, setReason] = useState("")

  const load = async () => {
    try { setRows((await authed("/api/admin/delivery-channels")).channels ?? []) }
    catch (e: any) { toast.error(e?.message || "Failed to load delivery channels") }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const apply = async (row: ChannelRow, down: boolean, why?: string) => {
    setUpdating(row.channel)
    try {
      await authed("/api/admin/delivery-channels", { method: "POST", body: JSON.stringify({ channel: row.channel, down, reason: why }) })
      toast.success(down ? `${row.label} marked as experiencing delays` : `${row.label} back to live estimates`)
      await load()
    } catch (e: any) {
      toast.error(e?.message || `Failed to update ${row.label}`)
    } finally {
      setUpdating(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Timer className="h-4 w-4" /> Delivery Estimate Channels</CardTitle>
        <CardDescription>
          Turn a channel off to show &quot;Experiencing delays&quot; on the dashboard. Its last numbers are frozen and purchase screens stop showing an estimate. This does not stop sales.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="divide-y rounded-lg border">
            {rows.map(row => (
              <div key={row.channel} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">{row.label}</span>
                    <Badge
                      variant={row.isManuallyDown ? "outline" : "secondary"}
                      className={row.isManuallyDown ? "bg-warning/15 text-warning border-border" : "bg-success/15 text-success border-border"}
                    >
                      {row.isManuallyDown ? "Experiencing delays" : "Live"}
                    </Badge>
                  </div>
                  {row.isManuallyDown && (row.reason || row.since) && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {row.reason ?? "No reason given"}{row.since ? ` · since ${new Date(row.since).toLocaleString()}` : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {updating === row.channel && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Switch
                    checked={!row.isManuallyDown}
                    disabled={updating !== null}
                    aria-label={`${row.label} live delivery estimate`}
                    onCheckedChange={checked => { if (checked) void apply(row, false); else { setReason(""); setConfirm(row) } }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={open => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {confirm?.label} as experiencing delays?</AlertDialogTitle>
            <AlertDialogDescription>
              The dashboard will show its current numbers frozen at 0% strength until you turn it back on. Customers can still buy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={reason} maxLength={200} placeholder="Reason (optional, shown on the dashboard)" onChange={e => setReason(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const row = confirm!; setConfirm(null); void apply(row, true, reason) }}>
              Mark as delayed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
