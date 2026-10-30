"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, Package, RefreshCw, ShoppingCart, Wallet, Wifi } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { supabase } from "@/lib/supabase"
import { networkLogoService } from "@/lib/shop-service"
import {
  bundleStatusLabel, findSameBundle, isCatalogStale, parsePrefixRules, type PrefixRules,
} from "@/lib/standard-bundles/ui-helpers"
import { NETWORK_SERVICE } from "@/lib/standard-bundles/categories"
import { SPECIAL_CATEGORY } from "@/lib/standard-bundles/special-format"
import {
  bundleCardPrice, groupBundleOrders, SPECIAL_BLURB, type BundleOrderRow, type SpecialInfo,
} from "@/lib/standard-bundles/special-ui"
import { useCashbackRates } from "@/components/cashback/use-cashback-rates"
import { BundleBuySheet, type PickedBundle } from "./BundleBuySheet"
import { useBundlesAvailability } from "./use-bundles-availability"

type Network = "MTN" | "TELECEL" | "AT"
/** `special` is present only on Special Bundles entries (MTN, dashboard). */
interface Bundle { value: string; display: string; amount: number; category: string; token: string; special?: SpecialInfo }
interface Category { name: string; bundles: Bundle[] }
/** A loaded catalog is always tagged with the network it was fetched for. */
interface Catalog { network: Network; categories: Category[]; fetchedAt: number }

const BUNDLE_GONE_MESSAGE = "Prices refreshed — that bundle is no longer offered. Please pick again."
type BundleOrder = BundleOrderRow

const STATUS_CLASSES: Record<string, string> = {
  pending: "bg-warning/10 text-warning",
  processing: "bg-primary/10 text-primary",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  refunded: "bg-muted text-muted-foreground",
}

const pillOn = "bg-foreground text-background shadow-sm"
const pillOff = "border border-border bg-card text-muted-foreground hover:text-foreground"

/** Same network colours and tiles as the Data Packages page. `logoKeys` are tried in order against the admin logos. */
const TILE_META: Record<Network, { label: string; logoKeys: string[]; card: string; border: string; avatar: string }> = {
  MTN: { label: "MTN", logoKeys: ["MTN"], card: "bg-mtn text-mtn-foreground", border: "border-mtn", avatar: "M" },
  TELECEL: { label: "Telecel", logoKeys: ["Telecel", "TELECEL"], card: "bg-telecel text-telecel-foreground", border: "border-telecel", avatar: "T" },
  AT: { label: "AirtelTigo", logoKeys: ["AT", "AirtelTigo", "AT - iShare"], card: "bg-at text-at-foreground", border: "border-at", avatar: "A" },
}
const TILE_ORDER: Network[] = ["MTN", "TELECEL", "AT"]

/** Cedi amounts as shown on this page (GH₵12.50). */
const cedi = (n: number): string => `GH₵${Number(n).toFixed(2)}`

export function StandardBundlesPage() {
  const router = useRouter()
  const availability = useBundlesAvailability()
  const { rates, ensureFresh } = useCashbackRates()

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
  /** Token of the tile whose buy sheet is opening (rates refresh in flight). */
  const [opening, setOpening] = useState<string | null>(null)

  const [logos, setLogos] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    networkLogoService.getLogosAsObject().then(l => { if (alive) setLogos(l ?? {}) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const logoFor = (keys: string[]): string => keys.map(k => logos[k]).find(Boolean) ?? ""

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
    setOpening(b.token)
    try {
      await ensureFresh() // re-fetch rates older than 5 minutes before the buy sheet opens
    } finally {
      setOpening(null)
    }
    const label = networks.find(n => n.network === net)?.label ?? net
    setPicked({
      token: chosen.token, display: chosen.display, amount: chosen.amount, network: net, networkLabel: label, category: category || undefined,
      ...(chosen.special ? { special: chosen.special } : {}),
    })
  }

  const onStale = async (message: string) => {
    const net = picked?.network
    setNotice(message)
    if (net) await loadCatalog(net)
    setPicked(null) // let the customer re-pick from the reloaded list
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl space-y-5 px-2 pb-16 sm:px-4 lg:max-w-6xl">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold text-foreground">
            <Wifi className="h-6 w-6 text-sky-500" /> Standard Bundles
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            MTN, Telecel, AirtelTigo and Telecel Broadband internet bundles — straight from your wallet
          </p>
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
                {balance === null ? "—" : cedi(balance)}
              </p>
            </div>

            <section className="space-y-4">
              {/* Network tiles: the Data Packages picker (logo, name, Live / Coming soon, check on the selected one) */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3" role="tablist" aria-label="Network">
                {TILE_ORDER.map(net => {
                  const m = TILE_META[net]
                  const live = networks.some(n => n.network === net)
                  const selected = live && activeNetwork === net
                  const logo = logoFor(m.logoKeys)
                  return (
                    <button
                      key={net}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      disabled={!live}
                      onClick={() => setNetwork(net)}
                      className={`relative flex flex-col items-center gap-1.5 rounded-2xl border-2 bg-card p-3 transition clay sm:p-4 ${
                        selected ? `${m.border} shadow-sm` : "border-transparent hover:border-[#1b388b]/30"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {selected && (
                        <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-success text-white">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        </span>
                      )}
                      {logo ? (
                        <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-card">
                          <img src={logo} alt={m.label} className="h-full w-full object-contain" />
                        </span>
                      ) : (
                        <span className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-extrabold ${m.card}`}>{m.avatar}</span>
                      )}
                      <span className="text-sm font-bold text-foreground">{m.label}</span>
                      <span className={`flex items-center gap-1 text-xs font-semibold ${live ? "text-success" : "text-warning"}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-success" : "bg-warning"}`} /> {live ? "Live" : "Coming soon"}
                      </span>
                    </button>
                  )
                })}
                {/* Telecel Broadband: not sold as a Standard Bundle yet (bills: Pay Bills). */}
                <div className="flex flex-col items-center gap-1.5 rounded-2xl border-2 border-transparent bg-card p-3 opacity-60 clay sm:p-4" aria-disabled="true">
                  {logoFor(TILE_META.TELECEL.logoKeys) ? (
                    <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-card">
                      <img src={logoFor(TILE_META.TELECEL.logoKeys)} alt="Telecel Broadband" className="h-full w-full object-contain" />
                    </span>
                  ) : (
                    <span className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-extrabold ${TILE_META.TELECEL.card}`}>T</span>
                  )}
                  <span className="text-center text-sm font-bold text-foreground">Telecel Broadband</span>
                  <span className="flex items-center gap-1 text-xs font-semibold text-warning">
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" /> Coming soon
                  </span>
                </div>
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
                      className={`shrink-0 rounded-full px-5 py-2 text-sm font-semibold transition ${category === c.name ? pillOn : pillOff}`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              {category === SPECIAL_CATEGORY && categories.some(c => c.name === SPECIAL_CATEGORY) && (
                <p className="-mt-2 text-xs text-muted-foreground">{SPECIAL_BLURB}</p>
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
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5" aria-busy={loadingCatalog}>
                  {visible.map(b => {
                    // Special: n × the per-unit display price (server rounding); normal: quoteForDisplay(amount) as before.
                    const q = activeNetwork ? bundleCardPrice(b, rates.services[NETWORK_SERVICE[activeNetwork]]) : null
                    const m = activeNetwork ? TILE_META[activeNetwork] : TILE_META.MTN
                    const logo = logoFor(m.logoKeys)
                    const busy = opening === b.token
                    return (
                      <div key={b.token} className={`flex flex-col overflow-hidden rounded-3xl shadow-sm ${m.card}`}>
                        <div className="flex flex-1 flex-col p-4 pb-5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-white/25">
                              {logo
                                ? <img src={logo} alt="" className="h-6 w-6 object-contain" />
                                : <span className="text-xs font-extrabold">{m.avatar}</span>}
                            </span>
                            <span className="rounded-full bg-black/10 px-2.5 py-1 text-xs font-bold">{m.label === "AirtelTigo" ? "AT" : m.label}</span>
                          </div>
                          <div className="mt-4 text-center">
                            <p className="break-words text-2xl font-extrabold leading-tight">{b.display}</p>
                            <p className="mt-1 text-lg font-bold">{cedi(q ? q.pay : b.amount)}</p>
                            {q?.applied && <p className="text-sm font-medium line-through opacity-60">{cedi(q.face)}</p>}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={loadingCatalog || opening !== null}
                          aria-busy={busy}
                          onClick={() => openBundle(b)}
                          className="flex w-full items-center justify-center gap-2 bg-black/10 py-3 text-sm font-bold transition hover:bg-black/15 disabled:opacity-60"
                        >
                          <ShoppingCart className="h-4 w-4" /> {busy ? "Opening…" : "Buy Now"}
                        </button>
                      </div>
                    )
                  })}
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
                  {groupBundleOrders(orders).map(line => {
                    // A Special group (one purchase, N child orders) shows as one line with a combined status.
                    const v = line.kind === "special"
                      ? { key: `group:${line.groupId}`, title: line.title, phone: line.beneficiary_phone, at: line.created_at, amount: line.amount, s: line.status }
                      : {
                          key: line.order.id, title: `${line.order.network} ${line.order.bundle_display}`, phone: line.order.beneficiary_phone,
                          at: line.order.created_at, amount: Number(line.order.amount), s: bundleStatusLabel(line.order.status, line.order.payment_status),
                        }
                    return (
                      <div key={v.key} className="flex items-center gap-3 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-foreground">{v.title}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{v.phone}</p>
                          <p className="text-xs text-muted-foreground">{new Date(v.at).toLocaleString()}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold text-foreground">{cedi(v.amount)}</p>
                          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASSES[v.s.tone] || "bg-muted text-muted-foreground"}`}>{v.s.label}</span>
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
          rates={rates}
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
