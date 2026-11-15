"use client"

import { useCallback, useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { supabase } from "@/lib/supabase"
import { ShieldAlert, Copy, Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { UserBlockedRow } from "@/lib/blocked-numbers/user-view"

type Section = "shops" | "orders"
type Resp = { rows: UserBlockedRow[]; total: number; page: number; hasShops: boolean; hasOrders: boolean; enabled: boolean }

const STATUS_LABEL = { waiting: "Waiting for activation", ready: "Ready", expired: "Expired" } as const
const STATUS_CLASS = {
  waiting: "bg-warning/15 text-warning",
  ready: "bg-success/15 text-success",
  expired: "bg-muted text-muted-foreground",
} as const
const SURFACE_LABEL = (s: string) =>
  s.startsWith("api") ? "API" : s.includes("bulk") ? "Bulk" : s.startsWith("dashboard") ? "Dashboard" : s
const PAGE_SIZE = 50

function fmt(d: string) {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

function SectionPanel({ section, title, hint, token }: { section: Section; title: string; hint: string; token: string }) {
  const [status, setStatus] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)

  const qs = useCallback(
    (p: number) => {
      const q = new URLSearchParams({ section, page: String(p) })
      if (status) q.set("status", status)
      if (from) q.set("from", new Date(from).toISOString())
      if (to) q.set("to", new Date(`${to}T23:59:59`).toISOString())
      return q
    },
    [section, status, from, to]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/user/blocked-numbers?${qs(page)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((b: Resp) => !cancelled && setData(b))
      .catch(() => !cancelled && toast.error("Could not load blocked numbers"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [qs, page, token])

  const exportXlsx = async () => {
    const q = qs(1)
    q.delete("page")
    const res = await fetch(`/api/user/blocked-numbers/export?${q}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return toast.error("Export failed")
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement("a")
    a.href = url
    a.download = `blocked-numbers-${section}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }

  const copy = (text: string, ok: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(ok), () => toast.error("Copy failed"))
  }

  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const readyNumbers = rows.filter((r) => r.status === "ready").map((r) => r.phone)

  return (
    <section className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="text-base font-bold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <select
          value={status}
          onChange={(e) => { setPage(1); setStatus(e.target.value) }}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          aria-label="Status"
        >
          <option value="">All statuses</option>
          <option value="waiting">Waiting for activation</option>
          <option value="ready">Ready</option>
          <option value="expired">Expired</option>
        </select>
        <input type="date" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value) }} className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm" aria-label="From" />
        <input type="date" value={to} onChange={(e) => { setPage(1); setTo(e.target.value) }} className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm" aria-label="To" />
        <button onClick={exportXlsx} className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90">
          <Download className="h-3.5 w-3.5" /> Export
        </button>
        {section === "orders" && (
          <button
            disabled={readyNumbers.length === 0}
            onClick={() => copy(readyNumbers.join("\n"), "Ready numbers copied")}
            className="flex items-center gap-1.5 rounded-full border border-primary px-3 py-1.5 text-xs font-bold text-primary disabled:opacity-40"
          >
            <Copy className="h-3.5 w-3.5" /> Copy ready numbers
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No numbers here.</p>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {rows.map((r) => (
            <li key={r.phone} className="rounded-xl border border-border p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-bold">{r.phone}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                First tried {fmt(r.firstTried)} · Last tried {fmt(r.lastTried)} · {r.attempts} attempt{r.attempts === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.products.length > 0 ? r.products.join(", ") : "Product not recorded"}
                {section === "orders" && ` · ${[...new Set(r.surfaces.map(SURFACE_LABEL))].join(", ")}`}
              </p>
              {r.status === "ready" && section === "shops" && (
                <button
                  onClick={() => copy(`Your number ${r.phone} is now ready. You can buy your data again now.`, "Message copied")}
                  className="mt-1 flex items-center gap-1.5 rounded-full border border-primary px-3 py-1 text-xs font-bold text-primary"
                >
                  <Copy className="h-3 w-3" /> Copy message
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-full border border-border px-3 py-1 disabled:opacity-40">Previous</button>
          <span>Page {page} of {pages} ({total} numbers)</span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-full border border-border px-3 py-1 disabled:opacity-40">Next</button>
        </div>
      )}
    </section>
  )
}

export default function BlockedNumbersPage() {
  const { user } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [meta, setMeta] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.id) return
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const t = session?.access_token
        if (!t) { toast.error("Your session expired. Please refresh and sign in again."); return }
        setToken(t)
        const res = await fetch("/api/user/blocked-numbers?section=shops&page=1", { headers: { Authorization: `Bearer ${t}` } })
        if (res.ok) setMeta(await res.json())
      } catch {
        toast.error("Could not load blocked numbers")
      } finally {
        setLoading(false)
      }
    })()
  }, [user])

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-6xl space-y-5">
        <DashboardHeroBanner
          backHref="/dashboard/my-shop"
          title="Blocked Numbers"
          subtitle="MTN numbers that could not be ordered for yet, and when they are ready."
          icon={ShieldAlert}
        />
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
        ) : !meta || !meta.enabled ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
            Some MTN numbers are refused until they are activated for data. When this feature is on, the numbers
            customers tried on your shop or your own orders will be listed here with their status.
          </div>
        ) : !meta.hasShops && !meta.hasOrders ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
            No blocked numbers for your shops or orders yet.
          </div>
        ) : (
          token && (
            <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
              {meta.hasShops && (
                <SectionPanel section="shops" title="My shops" hint="Numbers your customers tried to buy for on your shops." token={token} />
              )}
              {meta.hasOrders && (
                <SectionPanel section="orders" title="My orders" hint="Numbers refused on your dashboard and API orders. Ready numbers can be ordered again." token={token} />
              )}
            </div>
          )
        )}
      </div>
    </DashboardLayout>
  )
}
