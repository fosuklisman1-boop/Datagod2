"use client"

import { useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Button } from "@/components/ui/button"
import { shopService, shopPackageService } from "@/lib/shop-service"
import { packageService } from "@/lib/database"
import { supabase } from "@/lib/supabase"
import { shopOrigin } from "@/lib/shop-url"
import { PillToggle } from "@/components/shop/pill-toggle"
import { Tag, Send, AlertCircle, Loader2, Phone, GraduationCap, IdCard, Save, PartyPopper, Copy, MessageCircle, ExternalLink } from "lucide-react"
import { toast } from "sonner"

type Category = "data" | "airtime" | "results_checker" | "afa"
type DataSubTab = "manual" | "bulk"

const CATEGORY_TABS = [
  { id: "data", label: "Data Bundles", icon: Tag },
  { id: "airtime", label: "Airtime", icon: Phone },
  { id: "results_checker", label: "Results Checker", icon: GraduationCap },
  { id: "afa", label: "AFA Registration", icon: IdCard },
] as const

// "AT - iShare"/"AT - BigTime" -- WITH spaces. Same real gotcha this
// rebuild hit before (Data Packages page, network-stock-service.ts):
// the no-space variants silently match zero rows.
const NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]

export default function ShopPricingPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState<string | null>(null)
  const [category, setCategory] = useState<Category>("data")

  // Data Bundles
  const [dataSubTab, setDataSubTab] = useState<DataSubTab>("manual")
  const [selectedNetwork, setSelectedNetwork] = useState(NETWORKS[0])
  const [shopPackages, setShopPackages] = useState<any[]>([])
  const [allPackages, setAllPackages] = useState<any[]>([])
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({})
  const [savingPackageId, setSavingPackageId] = useState<string | null>(null)
  const [togglingStock, setTogglingStock] = useState(false)
  const [bulkMode, setBulkMode] = useState<"per_gb" | "percentage">("per_gb")
  const [bulkRate, setBulkRate] = useState("")
  const [bulkNetwork, setBulkNetwork] = useState(NETWORKS[0])
  const [bulkSelected, setBulkSelected] = useState<Record<string, boolean>>({})
  const [applyingBulk, setApplyingBulk] = useState(false)

  // Airtime
  const [airtimeMarkups, setAirtimeMarkups] = useState({ mtn: "0", telecel: "0", at: "0" })
  const [airtimeMaxMarkups, setAirtimeMaxMarkups] = useState({ mtn: 10, telecel: 10, at: 10 })
  const [airtimeNetworkCost, setAirtimeNetworkCost] = useState({ mtn: 0, telecel: 0, at: 0 })
  const [savingAirtime, setSavingAirtime] = useState(false)

  // Results Checker
  const [rcMarkups, setRcMarkups] = useState({ wassce: "0", bece: "0", novdec: "0" })
  const [rcMaxMarkups, setRcMaxMarkups] = useState({ wassce: 0, bece: 0, novdec: 0 })
  const [rcBasePrices, setRcBasePrices] = useState({ wassce: 0, bece: 0, novdec: 0 })
  const [rcBulk, setRcBulk] = useState<{ minQty: number; bulkPrice: Record<string, number> }>({ minQty: 0, bulkPrice: {} })
  const [savingRc, setSavingRc] = useState(false)

  // AFA
  const [afaPriceInput, setAfaPriceInput] = useState("")
  const [afaBaseCost, setAfaBaseCost] = useState(0)
  const [afaMaxProfit, setAfaMaxProfit] = useState(10)
  const [savingAfa, setSavingAfa] = useState(false)

  // "Go live" celebration -- shown once, the first time a shop with zero
  // pricing anywhere saves its first price via this page.
  const [hadPricingBefore, setHadPricingBefore] = useState<boolean | null>(null)
  const [showGoLiveModal, setShowGoLiveModal] = useState(false)
  const [savingAll, setSavingAll] = useState(false)

  useEffect(() => {
    if (!user) return
    loadAll()
  }, [user])

  const loadAll = async () => {
    try {
      setLoading(true)
      if (!user?.id) return
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      const meRes = token ? await fetch("/api/user/me", { headers: { Authorization: `Bearer ${token}` } }) : null
      const me = meRes?.ok ? await meRes.json() : null
      setUserRole(me?.role ?? (user?.user_metadata?.role as string | undefined) ?? null)

      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      if (!userShop) return

      const [shopPkgs, allPkgs, constraintsRes, cfgRes, afaPriceRow] = await Promise.all([
        shopPackageService.getShopPackages(userShop.id).catch(() => []),
        packageService.getPackages().catch(() => []),
        token ? fetch("/api/shop/airtime/constraints", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.ok ? r.json() : null).catch(() => null) : null,
        fetch("/api/public/config").then((r) => r.ok ? r.json() : { admin_settings: {} }).catch(() => ({ admin_settings: {} })),
        supabase.from("afa_registration_prices").select("price").eq("is_active", true).eq("name", "default").maybeSingle(),
      ])

      setShopPackages(shopPkgs || [])
      setAllPackages(allPkgs || [])

      // Snapshot BEFORE any edits this session -- drives the one-time "go live"
      // celebration in handleSaveAllAndGoLive (only fires shop's first-ever price).
      setHadPricingBefore(
        (shopPkgs?.length ?? 0) > 0 ||
        Number(userShop.airtime_markup_mtn) > 0 || Number(userShop.airtime_markup_telecel) > 0 || Number(userShop.airtime_markup_at) > 0 ||
        Number(userShop.results_checker_markup_wassce) > 0 || Number(userShop.results_checker_markup_bece) > 0 || Number(userShop.results_checker_markup_novdec) > 0 ||
        userShop.afa_price != null
      )

      if (constraintsRes) {
        setAirtimeMaxMarkups({ mtn: constraintsRes.mtn?.maxMarkup ?? 10, telecel: constraintsRes.telecel?.maxMarkup ?? 10, at: constraintsRes.at?.maxMarkup ?? 10 })
        setAirtimeNetworkCost({ mtn: constraintsRes.mtn?.baseFee ?? 0, telecel: constraintsRes.telecel?.baseFee ?? 0, at: constraintsRes.at?.baseFee ?? 0 })
      }
      setAirtimeMarkups({
        mtn: String(userShop.airtime_markup_mtn ?? 0),
        telecel: String(userShop.airtime_markup_telecel ?? 0),
        at: String(userShop.airtime_markup_at ?? 0),
      })

      const cfg = cfgRes?.admin_settings ?? {}
      setRcMaxMarkups({
        wassce: cfg.results_checker_max_markup_wassce?.max ?? 0,
        bece: cfg.results_checker_max_markup_bece?.max ?? 0,
        novdec: cfg.results_checker_max_markup_novdec?.max ?? 0,
      })
      setRcBasePrices({
        wassce: cfg.results_checker_price_wassce?.price ?? 0,
        bece: cfg.results_checker_price_bece?.price ?? 0,
        novdec: cfg.results_checker_price_novdec?.price ?? 0,
      })
      setRcBulk({
        minQty: cfg.results_checker_bulk_min_quantity?.min ?? 0,
        bulkPrice: {
          wassce: cfg.results_checker_bulk_price_wassce?.price ?? 0,
          bece: cfg.results_checker_bulk_price_bece?.price ?? 0,
          novdec: cfg.results_checker_bulk_price_novdec?.price ?? 0,
        },
      })
      setRcMarkups({
        wassce: String(userShop.results_checker_markup_wassce ?? 0),
        bece: String(userShop.results_checker_markup_bece ?? 0),
        novdec: String(userShop.results_checker_markup_novdec ?? 0),
      })
      setAfaMaxProfit(cfg.afa_max_shop_profit?.max ?? 10)

      setAfaBaseCost(afaPriceRow.data?.price ? parseFloat(afaPriceRow.data.price) : 0)
      setAfaPriceInput(userShop.afa_price != null ? String(userShop.afa_price) : "")
    } catch (error) {
      console.error("Error loading pricing:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load pricing")
    } finally {
      setLoading(false)
    }
  }

  const isDealer = userRole === "dealer" || userRole === "admin"

  // Same real base-price precedence used by the old My Shop page's
  // handleAddPackage: sub-agent parent price wins, then dealer price, then
  // the admin catalog price.
  const getBasePrice = (pkg: any): number => {
    const dealerPrice = pkg?.dealer_price > 0 ? Number(pkg.dealer_price) : undefined
    return pkg?.parent_price ?? (isDealer && dealerPrice ? dealerPrice : Number(pkg?.price)) ?? 0
  }

  const packagesForNetwork = useMemo(
    () => allPackages.filter((p) => p.network === selectedNetwork && p.is_available !== false),
    [allPackages, selectedNetwork]
  )

  const networkCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const net of NETWORKS) {
      counts[net] = shopPackages.filter((sp) => sp.packages?.network === net).length
    }
    return counts
  }, [shopPackages])

  const shopPkgFor = (packageId: string) => shopPackages.find((sp) => sp.package_id === packageId)

  const priceValueFor = (pkg: any) => {
    if (priceInputs[pkg.id] !== undefined) return priceInputs[pkg.id]
    const existing = shopPkgFor(pkg.id)
    const base = getBasePrice(pkg)
    return existing ? (base + Number(existing.profit_margin)).toFixed(2) : base.toFixed(2)
  }

  const handleSavePackagePrice = async (pkg: any) => {
    const base = getBasePrice(pkg)
    const sellingPrice = parseFloat(priceValueFor(pkg))
    if (!isFinite(sellingPrice) || sellingPrice < base) {
      toast.error("Selling price must be at least the cost price")
      return
    }
    const profitMargin = parseFloat((sellingPrice - base).toFixed(2))
    setSavingPackageId(pkg.id)
    try {
      const existing = shopPkgFor(pkg.id)
      if (existing) {
        await shopPackageService.updatePackageProfitMargin(existing.id, profitMargin)
      } else {
        await shopPackageService.addPackageToShop(shop.id, pkg.id, profitMargin)
      }
      const refreshed = await shopPackageService.getShopPackages(shop.id)
      setShopPackages(refreshed || [])
      toast.success(`${pkg.size}GB price saved`)
    } catch (error: any) {
      toast.error(error?.message || "Failed to save price")
    } finally {
      setSavingPackageId(null)
    }
  }

  const handleToggleNetworkStock = async (inStock: boolean) => {
    const rows = shopPackages.filter((sp) => sp.packages?.network === selectedNetwork)
    if (rows.length === 0) {
      toast.info("No packages added yet for this network")
      return
    }
    setTogglingStock(true)
    try {
      for (const row of rows) {
        await shopPackageService.togglePackageAvailability(row.id, inStock)
      }
      const refreshed = await shopPackageService.getShopPackages(shop.id)
      setShopPackages(refreshed || [])
      toast.success(inStock ? `${selectedNetwork} marked in stock` : `${selectedNetwork} marked out of stock`)
    } catch {
      toast.error("Failed to update stock")
    } finally {
      setTogglingStock(false)
    }
  }

  const networkInStock = useMemo(() => {
    const rows = shopPackages.filter((sp) => sp.packages?.network === selectedNetwork)
    return rows.length > 0 && rows.every((r) => r.is_available !== false)
  }, [shopPackages, selectedNetwork])

  const bulkPreview = useMemo(() => {
    const rate = parseFloat(bulkRate)
    if (!isFinite(rate) || rate <= 0) return []
    return allPackages
      .filter((p) => p.network === bulkNetwork && p.is_available !== false)
      .map((pkg) => {
        const base = getBasePrice(pkg)
        const existing = shopPkgFor(pkg.id)
        const currentSelling = existing ? base + Number(existing.profit_margin) : base
        const sizeGb = parseFloat(pkg.size) || 0
        const newSelling = bulkMode === "per_gb" ? rate * sizeGb : parseFloat((currentSelling * (1 + rate / 100)).toFixed(2))
        const newProfit = parseFloat((newSelling - base).toFixed(2))
        return { pkg, base, currentSelling, newSelling, newProfit, willUpdate: newSelling >= base }
      })
  }, [bulkRate, bulkMode, bulkNetwork, allPackages, shopPackages, userRole])

  const handleApplyBulk = async () => {
    const rows = bulkPreview.filter((r) => bulkSelected[r.pkg.id] !== false && r.willUpdate)
    if (rows.length === 0) {
      toast.error("Nothing to update")
      return
    }
    setApplyingBulk(true)
    try {
      for (const row of rows) {
        const existing = shopPkgFor(row.pkg.id)
        if (existing) {
          await shopPackageService.updatePackageProfitMargin(existing.id, row.newProfit)
        } else {
          await shopPackageService.addPackageToShop(shop.id, row.pkg.id, row.newProfit)
        }
      }
      const refreshed = await shopPackageService.getShopPackages(shop.id)
      setShopPackages(refreshed || [])
      toast.success(`Updated ${rows.length} package${rows.length === 1 ? "" : "s"}`)
    } catch (error: any) {
      toast.error(error?.message || "Bulk update failed")
    } finally {
      setApplyingBulk(false)
    }
  }

  const handleSaveAirtime = async () => {
    setSavingAirtime(true)
    try {
      const clamp = (val: string, max: number) => Math.max(0, Math.min(parseFloat(val) || 0, max))
      const updates = {
        airtime_markup_mtn: clamp(airtimeMarkups.mtn, airtimeMaxMarkups.mtn),
        airtime_markup_telecel: clamp(airtimeMarkups.telecel, airtimeMaxMarkups.telecel),
        airtime_markup_at: clamp(airtimeMarkups.at, airtimeMaxMarkups.at),
      }
      await shopService.updateShop(shop.id, updates)
      setShop((s: any) => ({ ...s, ...updates }))
      toast.success("Airtime profit saved")
    } catch (error: any) {
      toast.error(error?.message || "Failed to save")
    } finally {
      setSavingAirtime(false)
    }
  }

  const handleSaveRc = async () => {
    setSavingRc(true)
    try {
      const clamp = (val: string, max: number) => Math.max(0, Math.min(parseFloat(val) || 0, max))
      const updates = {
        results_checker_markup_wassce: clamp(rcMarkups.wassce, rcMaxMarkups.wassce),
        results_checker_markup_bece: clamp(rcMarkups.bece, rcMaxMarkups.bece),
        results_checker_markup_novdec: clamp(rcMarkups.novdec, rcMaxMarkups.novdec),
      }
      await shopService.updateShop(shop.id, updates)
      setShop((s: any) => ({ ...s, ...updates }))
      toast.success("Exam markups saved")
    } catch (error: any) {
      toast.error(error?.message || "Failed to save")
    } finally {
      setSavingRc(false)
    }
  }

  const handleSaveAfa = async () => {
    setSavingAfa(true)
    try {
      const trimmed = afaPriceInput.trim()
      if (!trimmed) {
        await shopService.updateShop(shop.id, { afa_price: null })
        setShop((s: any) => ({ ...s, afa_price: null }))
        toast.success("AFA registration turned off for your storefront")
        return
      }
      const price = parseFloat(trimmed)
      if (!isFinite(price) || price < afaBaseCost) {
        toast.error(`Price must be at least GH₵${afaBaseCost.toFixed(2)} (your cost)`)
        return
      }
      const cappedProfit = Math.min(price - afaBaseCost, afaMaxProfit)
      const finalPrice = parseFloat((afaBaseCost + cappedProfit).toFixed(2))
      await shopService.updateShop(shop.id, { afa_price: finalPrice })
      setShop((s: any) => ({ ...s, afa_price: finalPrice }))
      setAfaPriceInput(String(finalPrice))
      toast.success("AFA settings saved — now live on your storefront")
    } catch (error: any) {
      toast.error(error?.message || "Failed to save")
    } finally {
      setSavingAfa(false)
    }
  }

  const handleSaveAllAndGoLive = async () => {
    setSavingAll(true)
    try {
      await Promise.all([handleSaveAirtime(), handleSaveRc(), handleSaveAfa()])

      const hasPricingNow =
        shopPackages.length > 0 ||
        Number(airtimeMarkups.mtn) > 0 || Number(airtimeMarkups.telecel) > 0 || Number(airtimeMarkups.at) > 0 ||
        Number(rcMarkups.wassce) > 0 || Number(rcMarkups.bece) > 0 || Number(rcMarkups.novdec) > 0 ||
        afaPriceInput.trim() !== ""

      if (hadPricingBefore === false && hasPricingNow) {
        setShowGoLiveModal(true)
        setHadPricingBefore(true)
      }
    } finally {
      setSavingAll(false)
    }
  }

  const shopLink = shop ? (shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`) : ""

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  if (!shop) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl lg:max-w-4xl">
          <p className="text-sm text-muted-foreground">No shop found. Set one up from Overview first.</p>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        <DashboardHeroBanner backHref="/dashboard/my-shop" title="Pricing" subtitle="Set your profit on each service. Save sections individually or everything at once." icon={Tag}>
          <Button onClick={handleSaveAllAndGoLive} disabled={savingAll} className="shrink-0 rounded-full bg-white text-[#1b388b] hover:bg-white/90">
            {savingAll ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />} Save All & Go Live
          </Button>
        </DashboardHeroBanner>

        <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-foreground">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
          <p><span className="font-bold">Heads up!</span> New prices go live automatically, but admins reserve the right to review and reject them later.</p>
        </div>

        {/* Category tabs -- no "Mashup" (not a real product) or "AFA" folded
            in a way that pretends it's the same as the others; AFA is real
            here because it now has its own guest-checkout storefront flow. */}
        <div className="-mx-2 overflow-x-auto px-2 sm:mx-0 sm:px-0">
          <div className="inline-flex min-w-full gap-1 rounded-2xl bg-muted p-1 sm:min-w-0">
            {CATEGORY_TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setCategory(id)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold transition ${category === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>

        {category === "data" && (
          <div className="space-y-4">
            <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
              {(["manual", "bulk"] as DataSubTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setDataSubTab(t)}
                  className={`flex-1 rounded-xl py-2.5 text-sm font-bold capitalize transition ${dataSubTab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {dataSubTab === "manual" ? (
              <>
                <div className="rounded-2xl border border-success/30 bg-success/10 p-4 text-sm text-foreground">
                  Your cost is what you pay us; your profit is what you add on top. Example: cost GHS 10 + GHS 3 profit = customer pays GHS 13. You cannot sell below cost.
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {NETWORKS.map((net) => (
                    <button
                      key={net}
                      onClick={() => setSelectedNetwork(net)}
                      className={`flex items-center justify-between gap-2 rounded-2xl border-2 px-3 py-2.5 text-sm font-bold transition ${selectedNetwork === net ? "border-[#1b388b] bg-[#1b388b]/5 text-[#1b388b]" : "border-border bg-card text-foreground"} clay`}
                    >
                      {net}
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{networkCounts[net] || 0}</span>
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                  <p className="text-sm font-semibold text-foreground">{selectedNetwork}: {networkInStock ? "In Stock" : "Out of Stock"}</p>
                  <PillToggle checked={networkInStock} onChange={() => handleToggleNetworkStock(!networkInStock)} disabled={togglingStock} />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {packagesForNetwork.map((pkg) => {
                    const base = getBasePrice(pkg)
                    const value = priceValueFor(pkg)
                    const profit = parseFloat(value) - base
                    return (
                      <div key={pkg.id} className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-bold text-foreground">{pkg.size}GB</p>
                          <span className="text-xs text-muted-foreground">Cost: GH₵{base.toFixed(2)}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-1 rounded-xl border border-success/40 bg-success/5 px-3 py-2">
                          <span className="text-xs font-semibold text-muted-foreground">GHS</span>
                          <input
                            type="number"
                            step="0.01"
                            value={value}
                            onChange={(e) => setPriceInputs((p) => ({ ...p, [pkg.id]: e.target.value }))}
                            className="w-full bg-transparent text-sm font-bold text-foreground focus:outline-none"
                          />
                        </div>
                        <div className="mt-1 flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Profit</span>
                          <span className={profit >= 0 ? "text-success font-semibold" : "text-destructive font-semibold"}>
                            {profit >= 0 ? "+" : ""}GH₵{isFinite(profit) ? profit.toFixed(2) : "0.00"}
                          </span>
                        </div>
                        <button
                          onClick={() => handleSavePackagePrice(pkg)}
                          disabled={savingPackageId === pkg.id}
                          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-success py-2 text-sm font-bold text-white hover:bg-success/90 disabled:opacity-50"
                        >
                          {savingPackageId === pkg.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
                        </button>
                      </div>
                    )
                  })}
                  {packagesForNetwork.length === 0 && (
                    <p className="col-span-2 py-8 text-center text-sm text-muted-foreground">No {selectedNetwork} packages available right now.</p>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-sm font-bold text-foreground">Bulk Pricing</p>
                  <div className="inline-flex gap-1 rounded-full bg-muted p-1">
                    <button onClick={() => setBulkMode("per_gb")} className={`rounded-full px-3 py-1.5 text-xs font-bold ${bulkMode === "per_gb" ? "bg-[#1b388b] text-white" : "text-muted-foreground"}`}>Rate per GB (GHS)</button>
                    <button onClick={() => setBulkMode("percentage")} className={`rounded-full px-3 py-1.5 text-xs font-bold ${bulkMode === "percentage" ? "bg-[#1b388b] text-white" : "text-muted-foreground"}`}>Margin (%)</button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {bulkMode === "per_gb"
                    ? "Sets a selling price per GB — e.g. typing 5 means 1GB → GHS 5.00, 2GB → GHS 10.00. Profit is calculated automatically."
                    : "Increases each package's current selling price by this percentage. Profit is recalculated automatically."}
                </p>
                <div className="flex gap-2">
                  <select value={bulkNetwork} onChange={(e) => setBulkNetwork(e.target.value)} className="rounded-xl border border-white/60 dark:border-white/5 bg-background px-3 py-2.5 text-sm font-bold clay-inset">
                    {NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <div className="flex flex-1 items-center gap-1 rounded-xl border border-white/60 dark:border-white/5 bg-card px-3 py-2.5 clay">
                    <span className="text-xs font-semibold text-muted-foreground">{bulkMode === "per_gb" ? "GHS/GB" : "%"}</span>
                    <input type="number" step="0.01" value={bulkRate} onChange={(e) => setBulkRate(e.target.value)} placeholder="0" className="w-full bg-transparent text-sm font-bold focus:outline-none" />
                  </div>
                </div>

                {bulkPreview.length > 0 && (
                  <div className="overflow-x-auto rounded-xl border border-white/60 dark:border-white/5 bg-card clay">
                    <table className="w-full text-xs">
                      <thead className="border-b border-border">
                        <tr className="text-left text-muted-foreground">
                          <th className="p-2"></th>
                          <th className="p-2">Size</th>
                          <th className="p-2">Cost</th>
                          <th className="p-2">Current</th>
                          <th className="p-2">New</th>
                          <th className="p-2">New Profit</th>
                          <th className="p-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {bulkPreview.map((row) => (
                          <tr key={row.pkg.id}>
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={bulkSelected[row.pkg.id] !== false}
                                onChange={(e) => setBulkSelected((s) => ({ ...s, [row.pkg.id]: e.target.checked }))}
                              />
                            </td>
                            <td className="p-2 font-bold">{row.pkg.size}GB</td>
                            <td className="p-2">GH₵{row.base.toFixed(2)}</td>
                            <td className="p-2">GH₵{row.currentSelling.toFixed(2)}</td>
                            <td className="p-2 font-semibold">GH₵{row.newSelling.toFixed(2)}</td>
                            <td className={row.newProfit >= 0 ? "p-2 font-semibold text-success" : "p-2 font-semibold text-destructive"}>GH₵{row.newProfit.toFixed(2)}</td>
                            <td className="p-2">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${row.willUpdate ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>
                                {row.willUpdate ? "Will update" : "Below cost"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <Button onClick={handleApplyBulk} disabled={applyingBulk || bulkPreview.length === 0} className="w-full rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
                  {applyingBulk ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null} Apply Bulk Pricing
                </Button>
              </div>
            )}
          </div>
        )}

        {category === "airtime" && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 text-sm text-foreground">
              By default airtime profit is zero — you earn nothing until you set a markup below. The combined total fee (network cost + your markup) is capped at 10%.
            </div>
            <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card divide-y divide-border clay">
              {(["mtn", "telecel", "at"] as const).map((net) => (
                <div key={net} className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <p className="text-sm font-bold uppercase text-foreground">{net}</p>
                    <p className="text-xs text-muted-foreground">Network cost {airtimeNetworkCost[net].toFixed(2)}% · Max markup {airtimeMaxMarkups[net].toFixed(2)}%</p>
                  </div>
                  <div className="flex w-24 items-center gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2">
                    <input
                      type="number" step="0.1"
                      value={airtimeMarkups[net]}
                      onChange={(e) => setAirtimeMarkups((p) => ({ ...p, [net]: e.target.value }))}
                      className="w-full bg-transparent text-sm font-bold text-right focus:outline-none"
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              ))}
            </div>
            <Button onClick={handleSaveAirtime} disabled={savingAirtime} className="rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
              {savingAirtime ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />} Save Airtime Profit
            </Button>
          </div>
        )}

        {category === "results_checker" && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-success/30 bg-success/10 p-4 text-sm text-foreground">
              Set a separate profit for each exam type. Your profit is added to the voucher base price.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(["wassce", "bece", "novdec"] as const).map((board) => {
                const base = rcBasePrices[board]
                const markup = parseFloat(rcMarkups[board]) || 0
                const sellsFor = base + markup
                const bulkBase = rcBulk.bulkPrice[board] || 0
                const hasBulk = rcBulk.minQty > 0 && bulkBase > 0 && bulkBase < base
                return (
                  <div key={board} className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold uppercase text-foreground">{board}</p>
                      <span className="text-xs text-muted-foreground">Cost GH₵{base.toFixed(2)}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-1 rounded-xl border border-success/40 bg-success/5 px-3 py-2">
                      <span className="text-xs font-semibold text-muted-foreground">GHS</span>
                      <input
                        type="number" step="0.01"
                        value={rcMarkups[board]}
                        onChange={(e) => setRcMarkups((p) => ({ ...p, [board]: e.target.value }))}
                        className="w-full bg-transparent text-sm font-bold focus:outline-none"
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Sells for</span>
                      <span className="font-semibold text-foreground">GH₵{sellsFor.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Your profit</span>
                      <span className="font-semibold text-success">+GH₵{markup.toFixed(2)}</span>
                    </div>
                    {hasBulk && (
                      <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                        At {rcBulk.minQty}+ pcs: <span className="font-semibold text-success">GH₵{(bulkBase + markup).toFixed(2)}/ea</span>
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
            <Button onClick={handleSaveRc} disabled={savingRc} className="rounded-2xl bg-success text-white hover:bg-success/90">
              {savingRc ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />} Save Exam Markups
            </Button>
          </div>
        )}

        {category === "afa" && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-foreground">
              Type the full price you want to charge for an AFA registration — your profit is what's left after your cost. Saving a price turns AFA on for your storefront; clearing the field turns it off. You cannot sell below cost. Max profit per registration: <span className="font-bold">GHS {afaMaxProfit.toFixed(2)}</span>.
            </div>
            <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
              <div className="flex items-center justify-between gap-2">
                <p className="font-bold text-foreground">AFA Registration Price</p>
                <span className="text-xs text-muted-foreground">Cost: GH₵{afaBaseCost.toFixed(2)}</span>
              </div>
              <div className="mt-2 flex items-center gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2">
                <span className="text-xs font-semibold text-muted-foreground">GHS</span>
                <input
                  type="number" step="0.01"
                  value={afaPriceInput}
                  onChange={(e) => setAfaPriceInput(e.target.value)}
                  placeholder="e.g. 15.00"
                  className="w-full bg-transparent text-sm font-bold focus:outline-none"
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Profit</span>
                {afaPriceInput.trim() && isFinite(parseFloat(afaPriceInput)) ? (
                  <span className="font-semibold text-success">+GH₵{Math.max(0, parseFloat(afaPriceInput) - afaBaseCost).toFixed(2)}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              {!shop.afa_price && (
                <p className="mt-2 text-xs text-muted-foreground">AFA registration is currently off for your shop.</p>
              )}
            </div>
            <Button onClick={handleSaveAfa} disabled={savingAfa} className="rounded-2xl bg-amber-500 text-white hover:bg-amber-600">
              {savingAfa ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />} Save AFA Settings
            </Button>
          </div>
        )}
      </div>

      {showGoLiveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowGoLiveModal(false)}>
          <div className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/10">
              <PartyPopper className="h-7 w-7 text-success" />
            </div>
            <div>
              <p className="text-lg font-bold text-foreground">
                {shop.is_active ? "Your shop is fully set up!" : "Your pricing is saved!"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {shop.is_active
                  ? "Customers can now buy from your storefront. Share your link to find your first customers."
                  : "An admin reviews new shops before they go live — once approved, customers can buy from your storefront. Your link is ready to share now."}
              </p>
            </div>

            {shopLink && (
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(shopLink)}`}
                alt="Shop link QR code"
                className="mx-auto h-40 w-40 rounded-xl border border-border"
              />
            )}

            <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2">
              <code className="flex-1 truncate text-left font-mono text-xs text-foreground">{shopLink}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(shopLink); toast.success("Link copied") }}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground"
              >
                <Copy className="h-3 w-3" /> Copy Link
              </button>
            </div>

            <a
              href={`https://wa.me/?text=${encodeURIComponent(`Check out my shop for cheap data bundles, airtime & results checker vouchers: ${shopLink}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-success py-2.5 text-sm font-bold text-primary-foreground"
            >
              <MessageCircle className="h-4 w-4" /> Share on WhatsApp
            </a>

            <div className="rounded-xl bg-muted/50 p-3 text-left text-xs text-muted-foreground">
              <p className="mb-1 font-bold text-foreground">How to get more customers:</p>
              <ul className="space-y-1">
                <li>• Share your link in WhatsApp groups and your status daily.</li>
                <li>• Keep your prices slightly below local competitors.</li>
                <li>• Post your storefront notice with promos for returning buyers.</li>
                <li>• Respond fast on WhatsApp — speed builds trust and repeat sales.</li>
              </ul>
            </div>

            <div className="flex gap-2">
              <a
                href={shopLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-sm font-bold text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View Storefront
              </a>
              <button onClick={() => setShowGoLiveModal(false)} className="flex-1 rounded-xl bg-[#1b388b] py-2.5 text-sm font-bold text-white">Done</button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
