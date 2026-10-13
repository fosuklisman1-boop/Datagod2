"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useUserRole } from "@/hooks/use-user-role"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Copy, Check, RefreshCw, KeyRound, Loader2, Zap, Lock, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { BASE_URL } from "@/lib/api-docs-registry"

type Environment = "test" | "live"

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  environment: Environment
  last_used_at: string | null
  created_at: string
}

export function DeveloperKeysCard() {
  const { isDealer } = useUserRole()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<Environment | "both" | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  // Raw secrets are only ever known right after a generate call -- the
  // server only ever stores a hash, never the plaintext key.
  const [revealedKeys, setRevealedKeys] = useState<Partial<Record<Environment, string>>>({})
  const [copied, setCopied] = useState<Environment | null>(null)

  const [testKey, setTestKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; body: string } | null>(null)
  const [resetting, setResetting] = useState(false)

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

  const keyFor = (env: Environment) => keys.find((k) => k.environment === env)

  const generateKey = async (env: Environment): Promise<string | null> => {
    try {
      const res = await fetch("/api/user/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ environment: env }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || `Failed to generate ${env} key`)
        return null
      }
      return data.key as string
    } catch {
      toast.error(`Failed to generate ${env} key`)
      return null
    }
  }

  const handleGenerate = async (env: Environment) => {
    setGenerating(env)
    const key = await generateKey(env)
    if (key) {
      setRevealedKeys((prev) => ({ ...prev, [env]: key }))
      fetchKeys()
    }
    setGenerating(null)
  }

  const handleRegenerateBoth = async () => {
    setGenerating("both")
    const [testResultKey, liveResultKey] = await Promise.all([generateKey("test"), generateKey("live")])
    setRevealedKeys((prev) => ({
      ...prev,
      ...(testResultKey ? { test: testResultKey } : {}),
      ...(liveResultKey ? { live: liveResultKey } : {}),
    }))
    if (testResultKey || liveResultKey) fetchKeys()
    setGenerating(null)
  }

  const revokeKey = async (keyId: string, env: Environment) => {
    setRevoking(keyId)
    try {
      const res = await fetch(`/api/user/keys?id=${keyId}`, { method: "DELETE", headers: await authHeader() })
      if (res.ok) {
        toast.success(`${env === "test" ? "Test" : "Live"} key revoked`)
        setRevealedKeys((prev) => ({ ...prev, [env]: undefined }))
        fetchKeys()
      } else {
        const data = await res.json()
        toast.error(data.error || "Failed to revoke key")
      }
    } catch {
      toast.error("Failed to revoke key")
    } finally {
      setRevoking(null)
    }
  }

  const copyKey = async (env: Environment, key: string) => {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(env)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error("Failed to copy — please select and copy the key manually")
    }
  }

  const runBalanceTest = async (key: string) => {
    if (!key.trim() || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`${BASE_URL}/api/v1/balance`, { headers: { "X-API-Key": key.trim() } })
      const body = await res.text()
      setTestResult({ ok: res.ok, body })
    } catch {
      setTestResult({ ok: false, body: '{ "success": false, "error": "Request failed — check your network connection" }' })
    } finally {
      setTesting(false)
    }
  }

  const runResetBalance = async () => {
    if (!testKey.trim() || resetting) return
    setResetting(true)
    setTestResult(null)
    try {
      const res = await fetch(`${BASE_URL}/api/v1/sandbox/reset-balance`, {
        method: "POST",
        headers: { "X-API-Key": testKey.trim() },
      })
      const body = await res.text()
      setTestResult({ ok: res.ok, body })
    } catch {
      setTestResult({ ok: false, body: '{ "success": false, "error": "Request failed — check your network connection" }' })
    } finally {
      setResetting(false)
    }
  }

  const renderKeyRow = (env: Environment) => {
    const row = keyFor(env)
    const revealed = revealedKeys[env]
    const label = env === "test" ? "Test key" : "Live key"
    const prefix = env === "test" ? "dg_test_" : "dg_live_"

    return (
      <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{label} — {prefix}</p>
          {row && (
            <Badge variant="secondary" className="bg-success/15 text-success border-border text-xs">Active</Badge>
          )}
        </div>

        {revealed ? (
          <div className="mt-2 space-y-2">
            <p className="text-xs font-semibold text-success">Copy this key now — it won't be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background rounded-lg px-3 py-2 border font-mono break-all">{revealed}</code>
              <Button size="sm" variant="outline" className="shrink-0 rounded-full" onClick={() => copyKey(env, revealed)}>
                {copied === env ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                {copied === env ? "Copied" : "Copy"}
              </Button>
            </div>
            {env === "test" && (
              <Button
                size="sm"
                className="rounded-full bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90"
                onClick={() => { setTestKey(revealed); runBalanceTest(revealed) }}
              >
                <Zap className="w-3.5 h-3.5 mr-1.5" /> Test this key now
              </Button>
            )}
          </div>
        ) : row ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-mono text-muted-foreground truncate">{row.key_prefix}••••••••••••••••</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {row.last_used_at ? `Last used ${new Date(row.last_used_at).toLocaleDateString()}` : "Never used"}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                onClick={() => handleGenerate(env)}
                disabled={generating !== null}
              >
                {generating === env ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Regenerate"}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" aria-label={`Revoke ${label}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke your {label.toLowerCase()}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Any application using this key will immediately stop being able to authenticate. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => revokeKey(row.id, env)} className="bg-destructive hover:bg-destructive/90">
                      {revoking === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : "Revoke"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">No key yet.</p>
            <Button
              size="sm"
              className="rounded-full bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90"
              onClick={() => handleGenerate(env)}
              disabled={generating !== null}
            >
              {generating === env ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
              Generate
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 sm:p-5 clay">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-bold text-foreground"><Lock className="w-4 h-4 text-[#1b388b]" /> Your Keys</p>
        <div className="flex items-center gap-2">
          <Badge className={isDealer ? "bg-warning text-warning-foreground" : "bg-[#1b388b] text-primary-foreground"}>
            {isDealer ? "Executive Tier" : "Standard"}
          </Badge>
          <Button variant="outline" size="sm" className="rounded-full shrink-0" onClick={fetchKeys} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Two keys, one account. The prefix is the only thing that decides which environment a request runs in.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {renderKeyRow("test")}
        {renderKeyRow("live")}
      </div>

      <Button
        variant="outline"
        className="mt-3 w-full rounded-2xl"
        onClick={handleRegenerateBoth}
        disabled={generating !== null}
      >
        {generating === "both" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <KeyRound className="w-4 h-4 mr-2" />}
        Regenerate Both Keys
      </Button>

      {/* Try it -- real, live calls. GET /api/v1/balance with either key type
          works (it returns real or sandbox balance depending which key you
          paste); reset-balance only works with a test key. */}
      <div className="mt-4 rounded-2xl border border-border bg-muted/30 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-foreground"><Zap className="w-4 h-4 text-[#1b388b]" /> Try it</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Runs a real <code className="bg-background px-1 py-0.5 rounded border font-mono">GET /api/v1/balance</code> with one of your keys.
          A test key hits the sandbox balance below; a live key returns your real wallet balance.
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
            disabled={testing || resetting || !testKey.trim()}
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Run test"}
          </Button>
        </div>
        <button
          type="button"
          onClick={runResetBalance}
          disabled={testing || resetting || !testKey.trim()}
          className="mt-2 text-xs font-medium text-[#1b388b] hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {resetting ? "Resetting…" : "Reset test balance (test key only)"}
        </button>
        {testResult && (
          <pre className={`mt-3 rounded-lg border p-3 text-xs overflow-x-auto font-mono ${testResult.ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5"}`}>
            {testResult.body}
          </pre>
        )}
      </div>
    </div>
  )
}
