// components/developer/V2KeysPanel.tsx
"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import type { Environment, KeyType } from "@/lib/api-v2/keys"
import type { AccessSummary, DashboardAccessState } from "@/lib/api-v2/key-issue"
import type { V2KeySummary } from "@/lib/api-v2/key-slots"
import { GenerateKeyDialog, type IssuedKey } from "./GenerateKeyDialog"
import { KeysExplainer, LoadErrorCallout, V2KeysCard } from "./V2KeysCard"
import { slotId } from "./V2KeyBlock"

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return res.json().catch(() => ({}))
}

const LOAD_FAILED = "Failed to load your API keys"

/** Data owner for the v2 Keys tab: loads keys + access, generates and revokes. */
export function V2KeysPanel({ onAccessStateChange }: { onAccessStateChange?: (state: DashboardAccessState) => void }) {
  const [keys, setKeys] = useState<V2KeySummary[]>([])
  const [access, setAccess] = useState<AccessSummary | null>(null)
  const [loading, setLoading] = useState(true)
  // Set when the last load failed. Fail closed: no generate controls are rendered while it is set.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busySlot, setBusySlot] = useState<string | null>(null)
  // The full key exists only here, between a successful POST and the dialog closing.
  const [issued, setIssued] = useState<IssuedKey | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/user/v2-keys", { headers: await authHeader(), cache: "no-store" })
      const data = await readJson(res)
      const a = data.access as AccessSummary | undefined
      if (!res.ok || !a || typeof a.canGenerate !== "boolean") {
        const msg = typeof data.error === "string" ? data.error : LOAD_FAILED
        toast.error(msg)
        setLoadError(msg)
        return
      }
      setKeys(Array.isArray(data.keys) ? (data.keys as V2KeySummary[]) : [])
      setAccess(a)
      setLoadError(null)
    } catch {
      toast.error(LOAD_FAILED)
      setLoadError(LOAD_FAILED)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const retry = () => {
    setLoading(true)
    setLoadError(null)
    void load()
  }

  const state: DashboardAccessState = loading ? "loading" : loadError || !access ? "error" : access.reason
  useEffect(() => { onAccessStateChange?.(state) }, [state, onAccessStateChange])

  /** Runs one request at a time; a second click while one is running is ignored. */
  const run = async (slot: string, fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusySlot(slot)
    try {
      await fn()
    } finally {
      inFlight.current = false
      setBusySlot(null)
    }
  }

  const generate = (type: KeyType, env: Environment) =>
    run(slotId(type, env), async () => {
      try {
        const res = await fetch("/api/user/v2-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeader()) },
          body: JSON.stringify({ key_type: type, environment: env }),
        })
        const data = await readJson(res)
        if (res.status !== 201 || typeof data.key !== "string") {
          toast.error(typeof data.error === "string" ? data.error : "Could not generate the key, please try again")
          await load()
          return
        }
        setIssued({
          key: data.key,
          key_type: type,
          environment: env,
          status: data.status === "active" ? "active" : "pending",
        })
        await load()
      } catch {
        toast.error("Could not generate the key, please try again")
      }
    })

  const revoke = (key: V2KeySummary) =>
    run(slotId(key.key_type, key.environment), async () => {
      try {
        const res = await fetch(`/api/user/v2-keys?id=${encodeURIComponent(key.id)}`, {
          method: "DELETE",
          headers: await authHeader(),
        })
        const data = await readJson(res)
        if (res.ok) toast.success("API key revoked")
        else toast.error(typeof data.error === "string" ? data.error : "Could not revoke the key")
        await load()
      } catch {
        toast.error("Could not revoke the key")
      }
    })

  return (
    <div className="space-y-4">
      <KeysExplainer />
      {state === "error" ? (
        <LoadErrorCallout message={loadError ?? LOAD_FAILED} onRetry={retry} />
      ) : (
        <V2KeysCard
          keys={keys}
          access={access}
          loading={loading}
          busySlot={busySlot}
          onGenerate={(t, e) => void generate(t, e)}
          onRevoke={(k) => void revoke(k)}
        />
      )}
      <GenerateKeyDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  )
}
