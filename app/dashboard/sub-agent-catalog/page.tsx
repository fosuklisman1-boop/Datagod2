"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabase"
import { shopService } from "@/lib/shop-service"
import { Package, Users, DollarSign, Loader2, Save, Trash2, Check } from "lucide-react"
import { toast } from "sonner"

// Same real gotcha shop-pricing's bulk feature already hit: "AT - iShare"/
// "AT - BigTime" need the spaces, or they silently match zero packages.
const NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]

interface AdminPackage {
  id: string
  network: string
  size: string
  price: number
  dealer_price?: number
  is_available: boolean
}

interface CatalogItem {
  id: string
  package_id: string
  wholesale_margin: number
  profit_margin: number
  parent_price: number
  selling_price: number
  is_active: boolean
}

type SubTab = "manual" | "bulk"

export default function SubAgentCatalogPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [hasSubAgents, setHasSubAgents] = useState(false)
  const [isDealer, setIsDealer] = useState(false)
  const [allPackages, setAllPackages] = useState<AdminPackage[]>([])
  const [catalog, setCatalog] = useState<CatalogItem[]>([])

  const [subTab, setSubTab] = useState<SubTab>("manual")
  const [selectedNetwork, setSelectedNetwork] = useState(NETWORKS[0])
  const [sellingPriceInputs, setSellingPriceInputs] = useState<Record<string, string>>({})
  const [savingPackageId, setSavingPackageId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Bulk
  const [bulkMode, setBulkMode] = useState<"per_gb" | "percentage">("per_gb")
  const [bulkRate, setBulkRate] = useState("")
  const [bulkNetwork, setBulkNetwork] = useState(NETWORKS[0])
  const [bulkSelected, setBulkSelected] = useState<Record<string, boolean>>({})
  const [applyingBulk, setApplyingBulk] = useState(false)

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    try {
      setLoading(true)
      if (!user?.id) return

      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      if (!userShop) return

      const { data: subAgents } = await supabase
        .from("user_shops")
        .select("id")
        .eq("parent_shop_id", userShop.id)
        .limit(1)
      setHasSubAgents((subAgents?.length || 0) > 0)

      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) return

      const [catalogRes, pkgRes] = await Promise.all([
        fetch("/api/shop/sub-agent-catalog", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/shop/admin-packages"),
      ])

      const catalogData = await catalogRes.json()
      setCatalog(catalogData.catalog || [])
      setIsDealer(catalogData.is_dealer || false)

      const pkgData = await pkgRes.json()
      setAllPackages((pkgData.packages || []).filter((p: AdminPackage) => p.is_available !== false))
    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  // Same real base-price precedence shop-pricing's getBasePrice uses: dealer
  // price wins when this shop is a dealer and one is set, else admin price.
  // (This page is parent-tier only -- roles: ["user","admin","dealer"] in the
  // sidebar, sub_agent never sees it -- so there's no parent-markup layer to
  // account for here, unlike shop-pricing's version.)
  const getBasePrice = (pkg: AdminPackage): number => {
    const dealerPrice = pkg.dealer_price && pkg.dealer_price > 0 ? Number(pkg.dealer_price) : undefined
    return isDealer && dealerPrice ? dealerPrice : Number(pkg.price) || 0
  }

  const catalogFor = (packageId: string) => catalog.find((c) => c.package_id === packageId)

  const packagesForNetwork = useMemo(
    () => allPackages.filter((p) => p.network === selectedNetwork),
    [allPackages, selectedNetwork]
  )

  const networkCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const net of NETWORKS) {
      const pkgIdsForNet = new Set(allPackages.filter((p) => p.network === net).map((p) => p.id))
      counts[net] = catalog.filter((c) => pkgIdsForNet.has(c.package_id)).length
    }
    return counts
  }, [allPackages, catalog])

  const priceValueFor = (pkg: AdminPackage) => {
    if (sellingPriceInputs[pkg.id] !== undefined) return sellingPriceInputs[pkg.id]
    const existing = catalogFor(pkg.id)
    const base = getBasePrice(pkg)
    return existing ? Number(existing.selling_price ?? base + existing.profit_margin).toFixed(2) : base.toFixed(2)
  }

  const handleSaveManual = async (pkg: AdminPackage) => {
    const base = getBasePrice(pkg)
    const sellingPrice = parseFloat(priceValueFor(pkg))
    if (!isFinite(sellingPrice) || sellingPrice < base) {
      toast.error("Selling price must be at least your cost price")
      return
    }
    const margin = parseFloat((sellingPrice - base).toFixed(2))
    setSavingPackageId(pkg.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { toast.error("Not authenticated"); return }

      const res = await fetch("/api/shop/sub-agent-catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ package_id: pkg.id, wholesale_margin: margin, parent_price: sellingPrice }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save")

      toast.success(`${pkg.size}GB wholesale price saved`)
      await loadData()
    } catch (error: any) {
      toast.error(error?.message || "Failed to save price")
    } finally {
      setSavingPackageId(null)
    }
  }

  const handleRemoveFromCatalog = async (item: CatalogItem) => {
    if (!confirm("Remove this package from your sub-agent catalog?")) return
    setRemovingId(item.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { toast.error("Not authenticated"); return }

      const res = await fetch(`/api/shop/sub-agent-catalog?id=${item.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error("Failed to remove from catalog")

      toast.success("Package removed from catalog")
      setSellingPriceInputs((p) => { const next = { ...p }; delete next[item.package_id]; return next })
      await loadData()
    } catch (error: any) {
      toast.error(error.message || "Failed to remove from catalog")
    } finally {
      setRemovingId(null)
    }
  }

  const bulkPreview = useMemo(() => {
    const rate = parseFloat(bulkRate)
    if (!isFinite(rate) || rate <= 0) return []
    return allPackages
      .filter((p) => p.network === bulkNetwork)
      .map((pkg) => {
        const base = getBasePrice(pkg)
        const existing = catalogFor(pkg.id)
        const currentSelling = existing ? Number(existing.selling_price ?? base + existing.profit_margin) : base
        const sizeGb = parseFloat(pkg.size) || 0
        const newSelling = bulkMode === "per_gb" ? rate * sizeGb : parseFloat((currentSelling * (1 + rate / 100)).toFixed(2))
        const newMargin = parseFloat((newSelling - base).toFixed(2))
        return { pkg, base, currentSelling, newSelling, newMargin, willUpdate: newSelling >= base }
      })
  }, [bulkRate, bulkMode, bulkNetwork, allPackages, catalog, isDealer])

  const handleApplyBulk = async () => {
    const rows = bulkPreview.filter((r) => bulkSelected[r.pkg.id] !== false && r.willUpdate)
    if (rows.length === 0) {
      toast.error("Nothing to update")
      return
    }
    setApplyingBulk(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { toast.error("Not authenticated"); return }

      for (const row of rows) {
        await fetch("/api/shop/sub-agent-catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ package_id: row.pkg.id, wholesale_margin: row.newMargin, parent_price: row.newSelling }),
        })
      }
      await loadData()
      toast.success(`Updated ${rows.length} package${rows.length === 1 ? "" : "s"}`)
    } catch (error: any) {
      toast.error(error?.message || "Bulk update failed")
    } finally {
      setApplyingBulk(false)
    }
  }

  const avgMargin = catalog.length > 0
    ? catalog.reduce((sum, c) => sum + (c.profit_margin ?? c.wholesale_margin ?? 0), 0) / catalog.length
    : 0

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
          <p className="text-sm text-muted-foreground">You need to create a shop first before managing your sub-agent catalog.</p>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        <DashboardHeroBanner backHref="/dashboard/sub-agents" title="Sub-Agent Catalog" subtitle="Set the wholesale price your sub-agents pay for each package" icon={Package} />

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Package className="h-3.5 w-3.5" /> Catalog Packages</p>
            <p className="mt-1 text-xl font-black text-foreground">{catalog.length}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Has Sub-Agents</p>
            <p className="mt-1 text-xl font-black text-foreground">{hasSubAgents ? "Yes" : "No"}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><DollarSign className="h-3.5 w-3.5" /> Avg Margin</p>
            <p className="mt-1 text-xl font-black text-success">GHS {avgMargin.toFixed(2)}</p>
          </div>
        </div>

        {!hasSubAgents && (
          <div className="flex items-start gap-2 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 text-sm text-foreground">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-[#1b388b]" />
            <p>You don&apos;t have any sub-agents yet. Go to the <Link href="/dashboard/sub-agents" className="font-bold underline">Sub-Agents</Link> page to invite them. Once you set prices here, your sub-agents will be able to purchase and resell them.</p>
          </div>
        )}

        {/* Manual / Bulk sub-tabs */}
        <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
          {(["manual", "bulk"] as SubTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`flex-1 rounded-xl py-2.5 text-sm font-bold capitalize transition ${subTab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {t}
            </button>
          ))}
        </div>

        {subTab === "manual" ? (
          <>
            <div className="rounded-2xl border border-success/30 bg-success/10 p-4 text-sm text-foreground">
              Your cost is what you pay us; the price you set here is what your sub-agents pay you. Example: cost GHS 10, you set GHS 13 → your margin is GHS 3 per sale. You cannot sell below your cost.
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {NETWORKS.map((net) => (
                <button
                  key={net}
                  onClick={() => setSelectedNetwork(net)}
                  className={`flex items-center justify-between gap-2 rounded-2xl border-2 px-3 py-2.5 text-sm font-bold transition ${selectedNetwork === net ? "border-[#1b388b] bg-[#1b388b]/5 text-[#1b388b]" : "border-border bg-card text-foreground"}`}
                >
                  {net}
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{networkCounts[net] || 0}</span>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {packagesForNetwork.map((pkg) => {
                const base = getBasePrice(pkg)
                const value = priceValueFor(pkg)
                const margin = parseFloat(value) - base
                const existing = catalogFor(pkg.id)
                return (
                  <div key={pkg.id} className="rounded-2xl border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 font-bold text-foreground">
                        {pkg.size}GB
                        {existing && (
                          <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success"><Check className="h-2.5 w-2.5" /> In Catalog</span>
                        )}
                      </p>
                      <span className="text-xs text-muted-foreground">Cost: GH₵{base.toFixed(2)}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-1 rounded-xl border border-success/40 bg-success/5 px-3 py-2">
                      <span className="text-xs font-semibold text-muted-foreground">GHS</span>
                      <input
                        type="number"
                        step="0.01"
                        value={value}
                        onChange={(e) => setSellingPriceInputs((p) => ({ ...p, [pkg.id]: e.target.value }))}
                        className="w-full bg-transparent text-sm font-bold text-foreground focus:outline-none"
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Your margin</span>
                      <span className={margin >= 0 ? "text-success font-semibold" : "text-destructive font-semibold"}>
                        {margin >= 0 ? "+" : ""}GH₵{isFinite(margin) ? margin.toFixed(2) : "0.00"}
                      </span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => handleSaveManual(pkg)}
                        disabled={savingPackageId === pkg.id}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-success py-2 text-sm font-bold text-white hover:bg-success/90 disabled:opacity-50"
                      >
                        {savingPackageId === pkg.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
                      </button>
                      {existing && (
                        <button
                          onClick={() => handleRemoveFromCatalog(existing)}
                          disabled={removingId === existing.id}
                          className="flex items-center justify-center rounded-xl border border-destructive/30 px-3 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          {removingId === existing.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </div>
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
              <p className="text-sm font-bold text-foreground">Bulk Pricing</p>
              <div className="inline-flex gap-1 rounded-full bg-muted p-1">
                <button onClick={() => setBulkMode("per_gb")} className={`rounded-full px-3 py-1.5 text-xs font-bold ${bulkMode === "per_gb" ? "bg-[#1b388b] text-white" : "text-muted-foreground"}`}>Rate per GB (GHS)</button>
                <button onClick={() => setBulkMode("percentage")} className={`rounded-full px-3 py-1.5 text-xs font-bold ${bulkMode === "percentage" ? "bg-[#1b388b] text-white" : "text-muted-foreground"}`}>Margin (%)</button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {bulkMode === "per_gb"
                ? "Sets a wholesale price per GB — e.g. typing 5 means 1GB → GHS 5.00, 2GB → GHS 10.00. Your margin is calculated automatically."
                : "Increases each package's current wholesale price by this percentage. Your margin is recalculated automatically."}
            </p>
            <div className="flex gap-2">
              <select value={bulkNetwork} onChange={(e) => setBulkNetwork(e.target.value)} className="rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-bold">
                {NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <div className="flex flex-1 items-center gap-1 rounded-xl border border-border bg-card px-3 py-2.5">
                <span className="text-xs font-semibold text-muted-foreground">{bulkMode === "per_gb" ? "GHS/GB" : "%"}</span>
                <input type="number" step="0.01" value={bulkRate} onChange={(e) => setBulkRate(e.target.value)} placeholder="0" className="w-full bg-transparent text-sm font-bold focus:outline-none" />
              </div>
            </div>

            {bulkPreview.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-xs">
                  <thead className="border-b border-border">
                    <tr className="text-left text-muted-foreground">
                      <th className="p-2"></th>
                      <th className="p-2">Size</th>
                      <th className="p-2">Cost</th>
                      <th className="p-2">Current</th>
                      <th className="p-2">New</th>
                      <th className="p-2">New Margin</th>
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
                        <td className={row.newMargin >= 0 ? "p-2 font-semibold text-success" : "p-2 font-semibold text-destructive"}>GH₵{row.newMargin.toFixed(2)}</td>
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
    </DashboardLayout>
  )
}
