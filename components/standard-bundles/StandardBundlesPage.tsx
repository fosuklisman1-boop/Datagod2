"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Package, RefreshCw, Wallet } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { supabase } from "@/lib/supabase"
import {
  bundleStatusLabel, findSameBundle, formatGhs, isCatalogStale, parsePrefixRules, type PrefixRules,
} from "@/lib/standard-bundles/ui-helpers"
import { BundleBuySheet, type PickedBundle } from "./BundleBuySheet"
import { useBundlesAvailability } from "./use-bundles-availability"

type Network = "MTN" | "TELECEL" | "AT"
interface Bundle { value: string; display: string; amount: number; category: string; token: string }
interface Category { name: string; bundles: Bundle[] }
/** A loaded catalog is always tagged with the network it was fetched for. */
interface Catalog { network: Network; categories: Category[]; fetchedAt: number }

const BUNDLE_GONE_MESSAGE = "Prices refreshed — that bundle is no longer offered. Please pick again."
interface BundleOrder {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  bundle_display: string
  amount: number
  status: string
  payment_status: string
  created_at: string
}

const STATUS_CLASSES: Record<string, string> = {
  pending: "bg-warning/10 text-warning",
  processing: "bg-primary/10 text-primary",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  refunded: "bg-muted text-muted-foreground",
}

const pillOn = "bg-primary text-primary-foreground"
const pillOff = "border border-white/60 dark:border-white/5 bg-card text-foreground clay-sm"

export function StandardBundlesPage() {
  const router = useRouter()
  const availability = useBundlesAvailability()

  const [network, setNetwork] = useState<Network | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [category, setCategory] = useState("")
  const [notice, setNotice] = useState("")
  const [prefixRules, setPrefixRules] = useState<PrefixRules | null>(null)
  const catalogSeq = useRef(0)
  const catalogRef = useRef<Catalog | null>(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [catalogError, setCatalogError] = useState("")
  const [balance, setBalance] = useState<number | null>(null)
  const [phone, setPhone] = useState("")
  const [orders, setOrders] = useState<BundleOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(true)
  const [ordersError, setOrdersError] = useState("")
  const [picked, setPicked] = useState<PickedBundle | null>(null)

  const networks = availability?.networks ?? []
  const activeNetwork: Network | null = network && networks.some(n => n.network === network) ? network : (networks[0]?.network ?? null)
  const networkLabel = networks.find(n => n.network === activeNetwork)?.label ?? ""

  const loadWallet = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push("/auth/login"); return }
    const [w, u] = await Promise.all([
      supabase.from("wallets").select("balance").eq("user_id", session.user.id).single(),
      supabase.from("users").select("phone").eq("id", session.user.id).single(),
    ])
    setBalance(Number(w.data?.balance ?? 0))
    const p = (u.data as { phone?: string } | null)?.phone
    if (p) setPhone(p)
  }, [router])

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true)
    setOrdersError("")
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoadingOrders(false); return }
    try {
      const res = await fetch("/api/standard-bundles/orders", { headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(String(json?.error || "Could not load orders"))
      setOrders(Array.isArray(json.orders) ? json.orders : [])
    } catch (e) {
      setOrdersError(e instanceof Error ? e.message : "Could not load orders")
    } finally {
      setLoadingOrders(false)
    }
  }, [])

  /** Loads one network's catalog. Only the latest request wins; returns its categories, or null on failure/superseded. */
  const loadCatalog = useCallback(async (net: Network): Promise<Category[] | null> => {
    const putCatalog = (c: Catalog | null) => { catalogRef.current = c; setCatalog(c) }
    const seq = ++catalogSeq.current
    setLoadingCatalog(true)
    setCatalogError("")
    // Never show (or let anyone tap) another network's bundles while this one loads.
    if (catalogRef.current && catalogRef.current.network !== net) putCatalog(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { if (seq === catalogSeq.current) setLoadingCatalog(false); return null }
    try {
      const res = await fetch(`/api/standard-bundles/catalog?network=${net}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await res.json().catch(() => ({}))
      if (seq !== catalogSeq.current) return null
      if (!res.ok) throw new Error(String(json?.error || "Bundles unavailable right now"))
      const cats: Category[] = Array.isArray(json.categories) ? json.categories : []
      putCatalog({ network: net, categories: cats, fetchedAt: Date.now() })
      setCategory(prev => (cats.some(c => c.name === prev) ? prev : (cats[0]?.name ?? "")))
      return cats
    } catch (e) {
      if (seq !== catalogSeq.current) return null
      putCatalog(null)
      setCatalogError(e instanceof Error ? e.message : "Bundles unavailable right now")
      return null
    } finally {
      if (seq === catalogSeq.current) setLoadingCatalog(false)
    }
  }, [])

  useEffect(() => { loadWallet() }, [loadWallet])
  useEffect(() => { loadOrders() }, [loadOrders])
  useEffect(() => { setNotice(""); if (activeNetwork) loadCatalog(activeNetwork) }, [activeNetwork, loadCatalog])

  // Live admin prefix map + toggle (same source as the Data page). On failure the sheet only checks the number shape.
  useEffect(() => {
    let alive = true
    fetch("/api/network-prefixes")
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive) setPrefixRules(parsePrefixRules(j)) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // Catalog tokens expire after 10 minutes: refetch an old list when the customer comes back to the tab.
  const activeRef = useRef<Network | null>(null)
  activeRef.current = activeNetwork
  useEffect(() => {
    const refreshIfOld = () => {
      if (document.visibilityState !== "visible") return
      const net = activeRef.current
      const c = catalogRef.current
      if (net && c && c.network === net && isCatalogStale(c.fetchedAt, Date.now())) loadCatalog(net)
    }
    document.addEventListener("visibilitychange", refreshIfOld)
    window.addEventListener("focus", refreshIfOld)
    return () => {
      document.removeEventListener("visibilitychange", refreshIfOld)
      window.removeEventListener("focus", refreshIfOld)
    }
  }, [loadCatalog])

  const onChanged = () => { loadWallet(); loadOrders() }
  const categories = catalog && catalog.network === activeNetwork ? catalog.categories : []
  const visible = categories.find(c => c.name === category)?.bundles ?? []
  const catalogEmpty = !loadingCatalog && !catalogError && !!catalog && catalog.network === activeNetwork && catalog.categories.every(c => c.bundles.length === 0)

  const openBundle = async (b: Bundle) => {
    const c = catalogRef.current
    if (!c) return
    setNotice("")
    let chosen: Bundle | null = b
    let net = c.network
    if (isCatalogStale(c.fetchedAt, Date.now())) {
      // An old token would be refused: reload first and reopen the same bundle with a fresh token.
      const cats = await loadCatalog(net)
      if (!cats) return
      chosen = findSameBundle(cats, b)
      net = catalogRef.current?.network ?? net
      if (!chosen) { setNotice(BUNDLE_GONE_MESSAGE); return }
    }
    const label = networks.find(n => n.network === net)?.label ?? net
    setPicked({ token: chosen.token, display: chosen.display, amount: chosen.amount, network: net, networkLabel: label })
  }

  const onStale = async (message: string) => {
    const net = picked?.network
    setNotice(message)
    if (net) await loadCatalog(net)
    setPicked(null) // let the customer re-pick from the reloaded list
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl space-y-5 lg:max-w-5xl">
        <div className="flex items-start gap-3">
          <Package className="mt-1 h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-foreground">Standard Bundles</h1>
            <p className="text-sm text-muted-foreground">Buy data bundles straight from your wallet</p>
          </div>
        </div>

        {availability === null ? (
          <div className="py-10 text-center text-muted-foreground">Loading…</div>
        ) : networks.length === 0 ? (
          <div className="rounded-3xl border border-white/60 dark:border-white/5 bg-card p-8 text-center clay">
            <Package className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="font-bold text-foreground">Standard Bundles are not available yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Please check back soon.</p>
          </div>
        ) : (
          <>
            <div className="rounded-3xl border border-white/60 dark:border-white/5 bg-card p-5 clay">
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Wallet className="h-4 w-4" /> Wallet balance</p>
              <p className="mt-1 text-3xl font-extrabold text-foreground">
                {balance === null ? "—" : formatGhs(balance)}
              </p>
            </div>

            <section className="space-y-3">
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Network">
                {networks.map(n => (
                  <button
                    key={n.network}
                    type="button"
                    role="tab"
                    aria-selected={activeNetwork === n.network}
                    onClick={() => setNetwork(n.network)}
                    className={`rounded-full px-5 py-2.5 text-sm font-bold transition ${activeNetwork === n.network ? pillOn : pillOff}`}
                  >
                    {n.label}
                  </button>
                ))}
              </div>

              {categories.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Category">
                  {categories.map(c => (
                    <button
                      key={c.name}
                      type="button"
                      role="tab"
                      aria-selected={category === c.name}
                      onClick={() => setCategory(c.name)}
                      className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition ${category === c.name ? pillOn : pillOff}`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}

              {notice && (
                <div role="status" className="rounded-2xl bg-warning/10 px-4 py-3 text-sm font-medium text-warning">{notice}</div>
              )}
              {catalogError && (
                <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  <span>{catalogError}</span>
                  {activeNetwork && <button type="button" className="font-semibold underline" onClick={() => loadCatalog(activeNetwork)}>Retry</button>}
                </div>
              )}
              {loadingCatalog && categories.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">Loading bundles…</div>
              ) : catalogEmpty ? (
                <div className="rounded-3xl border border-white/60 dark:border-white/5 bg-card p-8 text-center clay">
                  <Package className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                  <p className="font-bold text-foreground">No {networkLabel} bundles available right now</p>
                  <p className="mt-1 text-sm text-muted-foreground">Please check back soon or try another network.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy={loadingCatalog}>
                  {visible.map(b => (
                    <button
                      key={b.token}
                      type="button"
                      disabled={loadingCatalog}
                      onClick={() => openBundle(b)}
                      className="flex flex-col items-start gap-2 rounded-3xl border border-white/60 dark:border-white/5 bg-card p-4 text-left transition hover:-translate-y-0.5 clay disabled:opacity-50 disabled:hover:translate-y-0"
                    >
                      <span className="text-sm font-bold text-foreground">{b.display}</span>
                      <span className="text-base font-extrabold text-primary">{formatGhs(b.amount)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">My Standard Bundle orders</h2>
                <button type="button" onClick={loadOrders} aria-label="Refresh orders" className="rounded-full p-2 text-muted-foreground hover:text-foreground">
                  <RefreshCw className={`h-4 w-4 ${loadingOrders ? "animate-spin" : ""}`} />
                </button>
              </div>
              {ordersError && <p role="alert" className="text-sm text-destructive">{ordersError}</p>}
              {loadingOrders && orders.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">Loading…</div>
              ) : orders.length === 0 ? (
                <div className="py-8 text-center">
                  <Package className="mx-auto mb-2 h-10 w-10 text-muted-foreground/40" />
                  <p className="font-bold text-foreground">No bundle orders yet</p>
                  <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">Your purchases will appear here with live delivery status.</p>
                </div>
              ) : (
                <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
                  {orders.map(o => {
                    const s = bundleStatusLabel(o.status, o.payment_status)
                    return (
                      <div key={o.id} className="flex items-center gap-3 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-foreground">{o.network} {o.bundle_display}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{o.beneficiary_phone}</p>
                          <p className="text-xs text-muted-foreground">{new Date(o.created_at).toLocaleString()}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold text-foreground">{formatGhs(Number(o.amount))}</p>
                          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASSES[s.tone] || "bg-muted text-muted-foreground"}`}>{s.label}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {picked && (
        <BundleBuySheet
          key={picked.token}
          bundle={picked}
          balance={balance}
          defaultPhone={phone}
          prefixRules={prefixRules}
          onClose={() => setPicked(null)}
          onChanged={onChanged}
          onStale={onStale}
        />
      )}
    </DashboardLayout>
  )
}
