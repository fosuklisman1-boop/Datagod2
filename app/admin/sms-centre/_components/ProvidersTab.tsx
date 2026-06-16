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
import { Loader2, Plus, RefreshCw } from "lucide-react"

const PROVIDERS = ["moolre", "mnotify", "brevo"] as const
type Provider = (typeof PROVIDERS)[number]

interface Routing {
  primary: string
  fallbacks: string[]
}

interface SenderId {
  id: string
  sender_id: string
  moolre_status: string | null
  local_status: "pending" | "active" | "rejected"
  last_polled_at: string | null
  sms_account_id: string | null
}

const STATUS_VARIANT: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  pending: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-700",
}

export default function ProvidersTab() {
  const [routing, setRouting] = useState<Routing>({ primary: "moolre", fallbacks: [] })
  const [senders, setSenders] = useState<SenderId[]>([])
  const [newSender, setNewSender] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([
      api<Routing>("/api/admin/sms-settings"),
      api<SenderId[]>("/api/admin/sms-sender-ids"),
    ])
    if (r.success && r.data) setRouting({ primary: r.data.primary, fallbacks: r.data.fallbacks ?? [] })
    if (s.success && s.data) setSenders(s.data)
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
      toast.success(`Submitted "${sid}". Approval is asynchronous — use "Poll now" to refresh status.`)
      await load()
    } else {
      toast.error(res.error ?? "Failed to submit sender ID")
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

  return (
    <div className="space-y-4">
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
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2 font-medium">Moolre status</th>
                    <th className="py-2 font-medium">Last polled</th>
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
                        <Badge className={STATUS_VARIANT[s.local_status] ?? "bg-muted text-muted-foreground"} variant="secondary">
                          {s.local_status}
                        </Badge>
                      </td>
                      <td className="py-2 text-muted-foreground">{s.moolre_status ?? "—"}</td>
                      <td className="py-2 text-muted-foreground">
                        {s.last_polled_at ? new Date(s.last_polled_at).toLocaleString() : "—"}
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
