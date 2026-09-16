"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Plus, Trash2, Copy, Check, RefreshCw, KeyRound } from "lucide-react"
import { toast } from "sonner"

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

const MAX_ACTIVE_KEYS = 5

export function DeveloperKeysCard() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [newKeyName, setNewKeyName] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const authHeader = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  }

  const fetchKeys = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/user/keys", { headers: await authHeader() })
      const data = await res.json()
      if (res.ok) setKeys(data.keys || [])
      else toast.error(data.error || "Failed to load API keys")
    } catch {
      toast.error("Failed to load API keys")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchKeys() }, [])

  const activeCount = keys.filter((k) => k.is_active).length

  const generateKey = async () => {
    if (generating || !newKeyName.trim()) return
    setGenerating(true)
    try {
      const res = await fetch("/api/user/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ name: newKeyName.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        setGeneratedKey(data.key)
        setNewKeyName("")
        fetchKeys()
      } else {
        toast.error(data.error || "Failed to generate key")
      }
    } catch {
      toast.error("Failed to generate key")
    } finally {
      setGenerating(false)
    }
  }

  const revokeKey = async (keyId: string) => {
    try {
      const res = await fetch(`/api/user/keys?id=${keyId}`, { method: "DELETE", headers: await authHeader() })
      if (res.ok) {
        toast.success("API key revoked")
        fetchKeys()
      } else {
        const data = await res.json()
        toast.error(data.error || "Failed to revoke key")
      }
    } catch {
      toast.error("Failed to revoke key")
    }
  }

  const copyKey = async () => {
    if (!generatedKey) return
    try {
      await navigator.clipboard.writeText(generatedKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Failed to copy — please select and copy the key manually")
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><KeyRound className="w-4 h-4" /> Your API Keys</CardTitle>
            <CardDescription>Generate keys to authenticate requests to the Datagod API ({activeCount}/{MAX_ACTIVE_KEYS} active).</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchKeys} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {generatedKey && (
          <div role="status" className="rounded-lg border border-success/30 bg-success/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-success">Copy your new key now — it won't be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background rounded px-3 py-2 border font-mono break-all">{generatedKey}</code>
              <Button size="sm" variant="outline" onClick={copyKey}>
                {copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setGeneratedKey(null)}>Dismiss</Button>
          </div>
        )}

        <div className="flex gap-2">
          <Input
            placeholder="Key name (e.g. My App)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generateKey()}
            disabled={generating || activeCount >= MAX_ACTIVE_KEYS}
          />
          <Button onClick={generateKey} disabled={generating || !newKeyName.trim() || activeCount >= MAX_ACTIVE_KEYS}>
            <Plus className="w-4 h-4 mr-1.5" />
            {generating ? "Generating..." : "Generate"}
          </Button>
        </div>
        {activeCount >= MAX_ACTIVE_KEYS && (
          <p className="text-xs text-muted-foreground">You've reached the {MAX_ACTIVE_KEYS}-key limit — revoke one to generate another.</p>
        )}

        <div className="divide-y rounded-lg border">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : keys.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No API keys yet. Generate your first key above.</div>
          ) : keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between p-3">
              <div>
                <div className="text-sm font-medium">{key.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{key.key_prefix}••••••••••••••••</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Created {new Date(key.created_at).toLocaleDateString()} ·{" "}
                  {key.last_used_at ? `Last used ${new Date(key.last_used_at).toLocaleDateString()}` : "Never used"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={key.is_active ? "secondary" : "outline"} className={key.is_active ? "bg-success/15 text-success border-border" : ""}>
                  {key.is_active ? "Active" : "Revoked"}
                </Badge>
                {key.is_active && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" aria-label={`Revoke ${key.name}`}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke this API key?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Any application using "{key.name}" will immediately stop being able to authenticate. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => revokeKey(key.id)} className="bg-destructive hover:bg-destructive/90">
                          Revoke
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
