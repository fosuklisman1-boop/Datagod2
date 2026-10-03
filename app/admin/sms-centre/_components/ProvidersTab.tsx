"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "../_lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"
import { Loader2, Plus, RefreshCw, Wallet, AlertTriangle } from "lucide-react"

const PROVIDERS = ["moolre", "mnotify", "brevo"] as const
type Provider = (typeof PROVIDERS)[number]

interface Routing {
  primary: string
  fallbacks: string[]
}

interface Supply {
  wholesaleBalance: number
  totalUsable: number
  totalPending: number
  headroom: number
}

interface SenderId {
  id: string
  sender_id: string
  moolre_status: string | null
  local_status: "pending" | "active" | "rejected"
  moolre_pushed_at: string | null
  last_polled_at: string | null
  mnotify_status: string | null
  mnotify_local_status: "pending" | "active" | "rejected"
  mnotify_pushed_at: string | null
  mnotify_last_polled_at: string | null
  sms_account_id: string | null
}

const STATUS_VARIANT: Record<string, string> = {
  active: "bg-success/15 text-success",
  pending: "bg-warning/15 text-warning",
  rejected: "bg-destructive/15 text-destructive",
}

export default function ProvidersTab() {
  const [routing, setRouting] = useState<Routing>({ primary: "moolre", fallbacks: [] })
  const [senders, setSenders] = useState<SenderId[]>([])
  const [supply, setSupply] = useState<Supply | null>(null)
  const [newSender, setNewSender] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [r, s, sup] = await Promise.all([
      api<Routing>("/api/admin/sms-settings"),
      api<SenderId[]>("/api/admin/sms-sender-ids"),
      api<Supply>("/api/admin/sms-supply"),
    ])
    if (r.success && r.data) setRouting({ primary: r.data.primary, fallbacks: r.data.fallbacks ?? [] })
    if (s.success && s.data) setSenders(s.data)
    if (sup.success && sup.data) setSupply(sup.data)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function toggleFallback(p: Provider) {
    setRouting((cur) =>
      cur.fallbacks.includes(p)
        ? { ...cur, fallbacks: cur.fallbacks.filter((x) => x !== p) }
        : { ...cur, fallbacks: [...cur.fallbacks, p] }
    )
  }

  async function saveRouting() {
    setBusy(true)
    // A provider can't be both primary and a fallback.
    const fallbacks = routing.fallbacks.filter((f) => f !== routing.primary)
    const res = await api<Routing>("/api/admin/sms-settings", {
      method: "PATCH",
      body: JSON.stringify({ primary: routing.primary, fallbacks }),
    })
    setBusy(false)
    if (res.success && res.data) {
      setRouting({ primary: res.data.primary, fallbacks: res.data.fallbacks ?? [] })
      toast.success("Routing saved.")
    } else {
      toast.error(res.error ?? "Failed to save routing")
    }
  }

  async function submitSender() {
    const sid = newSender.trim()
    if (!sid) return
    setBusy(true)
    const res = await api("/api/admin/sms-sender-ids", {
      method: "POST",
      body: JSON.stringify({ sender_id: sid }),
    })
    setBusy(false)
    if (res.success) {
      setNewSender("")
      toast.success(`Submitted "${sid}". Push to a provider below to start approval.`)
      await load()
    } else {
      toast.error(res.error ?? "Failed to submit sender ID")
    }
  }

  async function pushTo(id: string, provider: "moolre" | "mnotify") {
    setBusy(true)
    const res = await api("/api/admin/sms-sender-ids/push", {
      method: "POST",
      body: JSON.stringify({ id, provider }),
    })
    setBusy(false)
    if (res.success) {
      toast.success(`Pushed to ${provider === "moolre" ? "Moolre" : "mNotify"}.`)
      await load()
    } else {
      toast.error(res.error ?? "Push failed")
    }
  }

  async function rejectOn(id: string, provider: "moolre" | "mnotify" | "both") {
    setBusy(true)
    const res = await api("/api/admin/sms-sender-ids/reject", {
      method: "POST",
      body: JSON.stringify({ id, provider }),
    })
    setBusy(false)
    if (res.success) {
      toast.success("Rejected.")
      await load()
    } else {
      toast.error(res.error ?? "Reject failed")
    }
  }

  // Manual override for when the provider's own status-check API can't be
  // trusted (e.g. Moolre's /sms/query outage) but the admin independently
  // knows (their own dashboard, prior experience) that it's really approved.
  async function approveOn(id: string, provider: "moolre" | "mnotify" | "both") {
    setBusy(true)
    const res = await api("/api/admin/sms-sender-ids/approve", {
      method: "POST",
      body: JSON.stringify({ id, provider }),
    })
    setBusy(false)
    if (res.success) {
      toast.success("Marked approved.")
      await load()
    } else {
      toast.error(res.error ?? "Approve failed")
    }
  }

  async function fetchStatusFor(id: string, provider: "moolre" | "mnotify") {
    setBusy(true)
    const res = await api("/api/admin/sms-sender-ids/fetch-status", {
      method: "POST",
      body: JSON.stringify({ id, provider }),
    })
    setBusy(false)
    if (res.success) {
      toast.success("Status refreshed.")
      await load()
    } else {
      toast.error(res.error ?? "Fetch status failed")
    }
  }

  async function pollNow() {
    setBusy(true)
    const res = await api<{ polled: number; updated: number }>("/api/admin/sms-sender-ids/poll", { method: "POST" })
    setBusy(false)
    if (res.success && res.data) {
      toast.success(`Polled ${res.data.polled} pending sender ID(s); ${res.data.updated} updated.`)
      await load()
    } else {
      toast.error(res.error ?? "Poll failed")
    }
  }

  const shortfall = supply ? Math.max(0, supply.totalUsable + supply.totalPending - supply.wholesaleBalance) : 0

  return (
    <div className="space-y-4">
      {/* SMS supply (Moolre wholesale) + solvency */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><Wallet className="h-4 w-4" /> SMS supply</CardTitle>
              <CardDescription>Internal credits stay fully backed by the shared Moolre wholesale balance.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={busy}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Moolre wholesale" value={supply ? supply.wholesaleBalance.toLocaleString() : "…"} />
            <Stat label="Usable credits" value={supply ? supply.totalUsable.toLocaleString() : "…"} />
            <Stat label="Pending credits" value={supply ? supply.totalPending.toLocaleString() : "…"} />
            <Stat label="Headroom" value={supply ? supply.headroom.toLocaleString() : "…"} />
          </div>
          {supply && supply.totalPending > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {supply.totalPending.toLocaleString()} credit(s) are pending.
                {shortfall > 0
                  ? ` Top up the Moolre SMS balance by at least ${shortfall.toLocaleString()} units to release them.`
                  : " They’ll be released on the next pending-credits cron run."}
              </span>
            </div>
          )}
          {supply && supply.wholesaleBalance === 0 && (
            <p className="text-xs text-muted-foreground">
              A balance of 0 can also mean the Moolre API key isn’t configured in this environment (the balance read fails closed to 0).
            </p>
          )}
        </CardContent>
      </Card>

      {/* Provider routing */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider routing</CardTitle>
          <CardDescription>The primary provider is tried first; fallbacks are used (in order) if it fails.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="primary">Primary</Label>
            <Select
              value={routing.primary}
              onValueChange={(v) => setRouting((c) => ({ ...c, primary: v }))}
            >
              <SelectTrigger id="primary" className="w-48 bg-card">
                <SelectValue placeholder="Select primary provider" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Fallbacks</Label>
            <div className="flex flex-wrap gap-4">
              {PROVIDERS.filter((p) => p !== routing.primary).map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm capitalize cursor-pointer">
                  <Checkbox checked={routing.fallbacks.includes(p)} onCheckedChange={() => toggleFallback(p)} />
                  {p}
                </label>
              ))}
            </div>
          </div>

          <Button onClick={saveRouting} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save routing
          </Button>
        </CardContent>
      </Card>

      {/* Sender IDs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Sender IDs</CardTitle>
              <CardDescription>Admin view shows platform and tenant-owned sender IDs.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={pollNow} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Poll now
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={newSender}
              onChange={(e) => setNewSender(e.target.value)}
              placeholder="New sender ID (max 11 chars)"
              maxLength={11}
            />
            <Button onClick={submitSender} disabled={busy || !newSender.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Submit
            </Button>
          </div>

          {senders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sender IDs submitted yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 font-medium">Sender ID</th>
                    <th className="py-2 font-medium">Owner</th>
                    <th className="py-2 font-medium">Moolre</th>
                    <th className="py-2 font-medium">mNotify</th>
                  </tr>
                </thead>
                <tbody>
                  {senders.map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="py-2 font-mono">{s.sender_id}</td>
                      <td className="py-2">
                        <Badge variant="outline" className="text-[10px]">
                          {s.sms_account_id ? "tenant" : "platform"}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <ProviderCell
                          pushedAt={s.moolre_pushed_at}
                          localStatus={s.local_status}
                          rawStatus={s.moolre_status}
                          lastPolledAt={s.last_polled_at}
                          busy={busy}
                          onPush={() => pushTo(s.id, "moolre")}
                          onReject={() => rejectOn(s.id, "moolre")}
                          onApprove={() => approveOn(s.id, "moolre")}
                          onFetch={() => fetchStatusFor(s.id, "moolre")}
                        />
                      </td>
                      <td className="py-2">
                        <ProviderCell
                          pushedAt={s.mnotify_pushed_at}
                          localStatus={s.mnotify_local_status}
                          rawStatus={s.mnotify_status}
                          lastPolledAt={s.mnotify_last_polled_at}
                          busy={busy}
                          onPush={() => pushTo(s.id, "mnotify")}
                          onReject={() => rejectOn(s.id, "mnotify")}
                          onApprove={() => approveOn(s.id, "mnotify")}
                          onFetch={() => fetchStatusFor(s.id, "mnotify")}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  )
}

function ProviderCell({
  pushedAt,
  localStatus,
  rawStatus,
  lastPolledAt,
  busy,
  onPush,
  onReject,
  onApprove,
  onFetch,
}: {
  pushedAt: string | null
  localStatus: "pending" | "active" | "rejected"
  rawStatus: string | null
  lastPolledAt: string | null
  busy: boolean
  onPush: () => void
  onReject: () => void
  onApprove: () => void
  onFetch: () => void
}) {
  if (!pushedAt) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">Not pushed</span>
        <Button variant="outline" size="sm" onClick={onPush} disabled={busy}>
          Push
        </Button>
        <Button variant="outline" size="sm" onClick={onApprove} disabled={busy}>
          Mark approved
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <div>
        <Badge className={STATUS_VARIANT[localStatus] ?? "bg-muted text-muted-foreground"} variant="secondary">
          {localStatus}
        </Badge>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {rawStatus ?? "—"} · {lastPolledAt ? new Date(lastPolledAt).toLocaleString() : "never polled"}
        </p>
      </div>
      {localStatus === "pending" && (
        <>
          <Button variant="outline" size="sm" onClick={onFetch} disabled={busy}>
            Fetch
          </Button>
          <Button variant="outline" size="sm" onClick={onApprove} disabled={busy}>
            Mark approved
          </Button>
          <Button variant="outline" size="sm" onClick={onReject} disabled={busy}>
            Reject
          </Button>
        </>
      )}
      {localStatus === "rejected" && (
        <>
          <Button variant="outline" size="sm" onClick={onPush} disabled={busy}>
            Re-push
          </Button>
          <Button variant="outline" size="sm" onClick={onApprove} disabled={busy}>
            Mark approved
          </Button>
        </>
      )}
    </div>
  )
}
