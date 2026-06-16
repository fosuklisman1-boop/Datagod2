"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "../_lib/api"

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
  submitted_at: string
  last_polled_at: string | null
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  pending: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-700",
}

export default function ProvidersTab() {
  const [routing, setRouting] = useState<Routing>({ primary: "moolre", fallbacks: [] })
  const [senders, setSenders] = useState<SenderId[]>([])
  const [newSender, setNewSender] = useState("")
  const [msg, setMsg] = useState("")
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
    setMsg("")
    // A provider can't be both primary and a fallback.
    const fallbacks = routing.fallbacks.filter((f) => f !== routing.primary)
    const res = await api<Routing>("/api/admin/sms-settings", {
      method: "PATCH",
      body: JSON.stringify({ primary: routing.primary, fallbacks }),
    })
    setBusy(false)
    if (res.success && res.data) {
      setRouting({ primary: res.data.primary, fallbacks: res.data.fallbacks ?? [] })
      setMsg("Routing saved.")
    } else {
      setMsg(`Error: ${res.error}`)
    }
  }

  async function submitSender() {
    const sid = newSender.trim()
    if (!sid) return
    setBusy(true)
    setMsg("")
    const res = await api("/api/admin/sms-sender-ids", {
      method: "POST",
      body: JSON.stringify({ sender_id: sid }),
    })
    setBusy(false)
    if (res.success) {
      setNewSender("")
      setMsg(`Submitted "${sid}". Approval is asynchronous — use “Poll now” to refresh status.`)
      await load()
    } else {
      setMsg(`Error: ${res.error}`)
    }
  }

  async function pollNow() {
    setBusy(true)
    setMsg("")
    const res = await api<{ polled: number; updated: number }>("/api/admin/sms-sender-ids/poll", { method: "POST" })
    setBusy(false)
    if (res.success && res.data) {
      setMsg(`Polled ${res.data.polled} pending sender ID(s); ${res.data.updated} updated.`)
      await load()
    } else {
      setMsg(`Error: ${res.error}`)
    }
  }

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm rounded border bg-muted/40 px-3 py-2">{msg}</p>}

      {/* Provider routing */}
      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">Provider routing</h2>
        <p className="text-xs text-muted-foreground">
          The primary provider is tried first; fallbacks are used (in order) if it fails.
        </p>

        <div className="space-y-1">
          <label className="block text-sm font-medium">Primary</label>
          <select
            value={routing.primary}
            onChange={(e) => setRouting((c) => ({ ...c, primary: e.target.value }))}
            className="rounded border px-2 py-1 text-sm"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium">Fallbacks</label>
          <div className="flex flex-wrap gap-3">
            {PROVIDERS.filter((p) => p !== routing.primary).map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={routing.fallbacks.includes(p)}
                  onChange={() => toggleFallback(p)}
                />
                {p}
              </label>
            ))}
          </div>
        </div>

        <button
          onClick={saveRouting}
          disabled={busy}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          Save routing
        </button>
      </section>

      {/* Sender IDs */}
      <section className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Sender IDs</h2>
          <button
            onClick={pollNow}
            disabled={busy}
            className="rounded border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50"
          >
            Poll now
          </button>
        </div>

        <div className="flex gap-2">
          <input
            value={newSender}
            onChange={(e) => setNewSender(e.target.value)}
            placeholder="New sender ID (max 11 chars)"
            maxLength={11}
            className="flex-1 rounded border px-2 py-1 text-sm"
          />
          <button
            onClick={submitSender}
            disabled={busy || !newSender.trim()}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            Submit
          </button>
        </div>

        {senders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sender IDs submitted yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1.5 font-medium">Sender ID</th>
                <th className="py-1.5 font-medium">Status</th>
                <th className="py-1.5 font-medium">Moolre status</th>
                <th className="py-1.5 font-medium">Last polled</th>
              </tr>
            </thead>
            <tbody>
              {senders.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="py-1.5 font-mono">{s.sender_id}</td>
                  <td className="py-1.5">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLE[s.local_status] ?? "bg-muted text-muted-foreground"
                      }`}
                    >
                      {s.local_status}
                    </span>
                  </td>
                  <td className="py-1.5 text-muted-foreground">{s.moolre_status ?? "—"}</td>
                  <td className="py-1.5 text-muted-foreground">
                    {s.last_polled_at ? new Date(s.last_polled_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
