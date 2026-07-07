"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Loader2, ShieldCheck, X, Plus } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

type Net = "MTN" | "TELECEL" | "AT"
const NETWORKS: Net[] = ["MTN", "TELECEL", "AT"]
const NETWORK_LABEL: Record<Net, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function NetworkPrefixSettingsCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [map, setMap] = useState<Record<Net, string[]> | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [newPrefix, setNewPrefix] = useState<Record<Net, string>>({ MTN: "", TELECEL: "", AT: "" })
  const [busyPrefix, setBusyPrefix] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const [tRes, mRes] = await Promise.all([
        fetch("/api/admin/settings/network-prefix-validation", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/admin/settings/network-prefixes", { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (tRes.ok) setEnabled((await tRes.json()).enabled)
      if (mRes.ok) setMap((await mRes.json()).map)
    } catch {
      toast.error("Failed to load prefix validation settings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleToggle = async (next: boolean) => {
    setToggling(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/settings/network-prefix-validation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to update")
      setEnabled(next)
      toast.success(data.message || `Prefix validation ${next ? "enabled" : "disabled"}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update")
    } finally {
      setToggling(false)
    }
  }

  const mutatePrefix = async (network: Net, prefix: string, action: "add" | "remove") => {
    setBusyPrefix(`${network}:${prefix}:${action}`)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/settings/network-prefixes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ network, prefix, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to update prefixes")
      setMap(data.map)
      if (action === "add") setNewPrefix(prev => ({ ...prev, [network]: "" }))
      toast.success(`0${prefix.replace(/^0/, "")} ${action === "add" ? "added to" : "removed from"} ${NETWORK_LABEL[network]}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update prefixes")
    } finally {
      setBusyPrefix(null)
    }
  }

  return (
    <Card className="mb-6 border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5" />
          Network Prefix Validation
        </CardTitle>
        <CardDescription>
          Blocks data orders when the phone number&apos;s prefix doesn&apos;t match the selected
          network (e.g. a Telecel 020 number on an MTN bundle). The prefix map below also drives
          the MTN registration export.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg">
              <div>
                <p className="font-medium text-foreground">
                  {enabled ? "🟢 ENABLED — mismatched orders are blocked" : "⚪ DISABLED — orders accepted as before"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Turn off temporarily if a genuinely ported number needs to order.
                </p>
              </div>
              <Switch checked={!!enabled} onCheckedChange={handleToggle} disabled={toggling} />
            </div>

            <div className="space-y-4">
              {NETWORKS.map(net => (
                <div key={net} className="space-y-2">
                  <p className="text-sm font-medium text-foreground">{NETWORK_LABEL[net]} prefixes</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {(map?.[net] ?? []).map(p => (
                      <Badge key={p} variant="secondary" className="gap-1">
                        0{p}
                        <button
                          onClick={() => mutatePrefix(net, p, "remove")}
                          disabled={busyPrefix !== null}
                          className="ml-1 hover:text-destructive"
                          title={`Remove 0${p} from ${NETWORK_LABEL[net]}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    ))}
                    <div className="flex items-center gap-1">
                      <Input
                        value={newPrefix[net]}
                        onChange={e => setNewPrefix(prev => ({ ...prev, [net]: e.target.value }))}
                        placeholder="058"
                        className="h-8 w-20 text-sm"
                        maxLength={3}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutatePrefix(net, newPrefix[net], "add")}
                        disabled={busyPrefix !== null || !newPrefix[net].trim()}
                      >
                        {busyPrefix?.startsWith(`${net}:`) ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
