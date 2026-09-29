"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Plus, Trash2, Copy, Check, RefreshCw, KeyRound, Loader2, Zap } from "lucide-react"
import { toast } from "sonner"
import { BASE_URL } from "@/lib/api-docs-registry"

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

  // "Try it" -- a real call to GET /api/v1/balance. We never store a key's
  // raw secret (only its hash), so this only works with a key the user has
  // in hand right now: either the one just generated above, or one they
  // paste in themselves. Not a sandbox -- it hits the real live endpoint
  // and returns the real wallet balance.
  const [testKey, setTestKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; body: string } | null>(null)

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

  const runBalanceTest = async (key: string) => {
    if (!key.trim() || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`${BASE_URL}/api/v1/balance`, {
        headers: { "X-API-Key": key.trim() },
      })
      const body = await res.text()
      setTestResult({ ok: res.ok, body })
    } catch {
      setTestResult({ ok: false, body: '{ "success": false, "error": "Request failed — check your network connection" }' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-bold text-foreground"><KeyRound className="w-4 h-4 text-primary" /> Your API Keys</p>
          <p className="text-xs text-muted-foreground">Generate keys to authenticate requests ({activeCount}/{MAX_ACTIVE_KEYS} active).</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-full shrink-0" onClick={fetchKeys} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {generatedKey && (
          <div role="status" className="rounded-2xl border border-success/30 bg-success/5 p-4 space-y-3">
            <p className="text-sm font-semibold text-success">Copy your new key now — it won't be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background rounded-lg px-3 py-2 border font-mono break-all">{generatedKey}</code>
              <Button size="sm" variant="outline" className="shrink-0 rounded-full" onClick={copyKey}>
                {copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => { setTestKey(generatedKey); runBalanceTest(generatedKey) }}
                disabled={testing}
              >
                {testing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1.5" />}
                Test this key now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setGeneratedKey(null)}>Dismiss</Button>
            </div>
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
          <Button
            onClick={generateKey}
            disabled={generating || !newKeyName.trim() || activeCount >= MAX_ACTIVE_KEYS}
            className="shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            {generating ? "Generating..." : "Generate"}
          </Button>
        </div>
        {activeCount >= MAX_ACTIVE_KEYS && (
          <p className="text-xs text-muted-foreground">You've reached the {MAX_ACTIVE_KEYS}-key limit — revoke one to generate another.</p>
        )}

        <div className="divide-y rounded-2xl border border-border overflow-hidden">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : keys.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No API keys yet. Generate your first key above.</div>
          ) : keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between gap-3 p-3 bg-card">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{key.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{key.key_prefix}••••••••••••••••</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Created {new Date(key.created_at).toLocaleDateString()} ·{" "}
                  {key.last_used_at ? `Last used ${new Date(key.last_used_at).toLocaleDateString()}` : "Never used"}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
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

        {/* Try it -- real, live GET /api/v1/balance. We never keep a raw key
            server-side, so this always needs one typed/pasted in, not a
            persistent "sandbox" session. */}
        <div className="rounded-2xl border border-border bg-muted/30 p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-foreground"><Zap className="w-4 h-4 text-primary" /> Try it</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Runs a real <code className="bg-background px-1 py-0.5 rounded border font-mono">GET /api/v1/balance</code> with one of your keys — it only reads your wallet balance, it can't place an order or spend anything.
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="Paste one of your API keys"
              value={testKey}
              onChange={(e) => { setTestKey(e.target.value); setTestResult(null) }}
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              className="shrink-0 rounded-full"
              onClick={() => runBalanceTest(testKey)}
              disabled={testing || !testKey.trim()}
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Run test"}
            </Button>
          </div>
          {testResult && (
            <pre className={`mt-3 rounded-lg border p-3 text-xs overflow-x-auto font-mono ${testResult.ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5"}`}>
              {testResult.body}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
