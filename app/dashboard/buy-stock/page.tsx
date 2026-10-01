"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Wallet,
  Loader2,
  AlertCircle,
  ShoppingCart,
  Grid3x3,
  List,
  Search,
  CheckCircle2,
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { networkLogoService } from "@/lib/shop-service"
import { PurchaseSheet, type PurchaseSheetModal } from "@/components/dashboard/PurchaseSheet"

interface WholesalePackage {
  id: string
  package_id?: string
  network: string
  size: string
  parent_price: number
  description?: string
  profit_margin?: number
}

// Same real brand tokens Data Packages uses (app/dashboard/data-packages/
// page.tsx) -- not shared via a lib, each page defines its own copy, matching
// the established pattern across this rebuild. Keys match the real
// packages.network values exactly: "AT - iShare" / "AT - BigTime", WITH
// spaces around the hyphen.
const NETWORK_META: Record<string, { label: string; avatar: string; badge: string; className: string; border: string }> = {
  MTN: { label: "MTN", avatar: "M", badge: "MTN", className: "bg-mtn text-mtn-foreground", border: "border-mtn" },
  Telecel: { label: "Telecel", avatar: "T", badge: "Telecel", className: "bg-telecel text-telecel-foreground", border: "border-telecel" },
  "AT - iShare": { label: "AT iShare", avatar: "A", badge: "AT-iS", className: "bg-at text-at-foreground", border: "border-at" },
  "AT - BigTime": { label: "AT BigTime", avatar: "A", badge: "AT-BT", className: "bg-violet-600 text-white", border: "border-violet-600" },
}
const NETWORK_ORDER = Object.keys(NETWORK_META)

export default function BuyStockPage() {
  const [loading, setLoading] = useState(true)
  const [packages, setPackages] = useState<WholesalePackage[]>([])
  const [walletBalance, setWalletBalance] = useState(0)
  const [purchasing, setPurchasing] = useState<string | null>(null)
  const [userRole, setUserRole] = useState<string | null>(null)
  const [shopId, setShopId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [selectedNetwork, setSelectedNetwork] = useState("MTN")
  const [searchTerm, setSearchTerm] = useState("")
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})

  // Purchase sheet state
  const [purchaseModal, setPurchaseModal] = useState<PurchaseSheetModal | null>(null)
  // Guards the in-flight purchase call from reopening a stale success/failed
  // view after the customer already dismissed the sheet themselves.
  const purchaseDismissedRef = useRef(false)
  const [selectedPackageForPurchase, setSelectedPackageForPurchase] = useState<WholesalePackage | null>(null)
  const [globalOrderingEnabled, setGlobalOrderingEnabled] = useState(true)

  useEffect(() => {
    loadData()
    loadNetworkLogos()
  }, [])

  const loadNetworkLogos = async () => {
    try {
      const logos = await networkLogoService.getLogosAsObject()
      setNetworkLogos(logos)
    } catch (error) {
      console.error("Error loading network logos:", error)
    }
  }

  const getNetworkLogo = (network: string): string => {
    if (networkLogos[network]) return networkLogos[network]
    const normalized = network.charAt(0).toUpperCase() + network.slice(1).toLowerCase()
    return networkLogos[normalized] || ""
  }

  const extractSizeValue = (size: string): number => {
    const normalized = size.trim().toUpperCase()
    const match = normalized.match(/^(\d+)(?:\D|$)/)
    if (!match) return 0
    return parseInt(match[1], 10)
  }

  const loadData = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.user) {
        toast.error("Please log in")
        return
      }

      // Get user role
      const { data: userData } = await supabase
        .from("users")
        .select("role")
        .eq("id", session.user.id)
        .single()

      setUserRole(userData?.role || null)

      // Get user's shop with parent info
      const { data: shop, error: shopError } = await supabase
        .from("user_shops")
        .select("id, parent_shop_id")
        .eq("user_id", session.user.id)
        .single()

      if (shopError || !shop) {
        toast.error("Shop not found")
        return
      }

      setShopId(shop.id)

      // Get wallet balance
      try {
        const { data: wallet } = await supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", session.user.id)
          .single()
        setWalletBalance(wallet?.balance ?? 0)
      } catch (walletError) {
        setWalletBalance(0)
      }

      // Get packages based on user type: dealer or sub-agent
      const token = session.access_token
      if (!token) {
        toast.error("Authentication error")
        return
      }

      // For dealers/admins, get all admin packages
      const isDealer = userData?.role === 'dealer' || userData?.role === 'admin'
      if (isDealer) {
        const dealerResponse = await fetch("/api/shop/dealer-packages", {
          headers: { "Authorization": `Bearer ${token}` }
        })

        if (!dealerResponse.ok) {
          console.error("API Error:", dealerResponse.status, dealerResponse.statusText)
          toast.error(`Failed to fetch dealer packages: ${dealerResponse.statusText}`)
          return
        }

        const dealerData = await dealerResponse.json()
        console.log("[BUY-STOCK] Fetched dealer packages:", dealerData)

        if (dealerData.packages && dealerData.packages.length > 0) {
          // Transform to match WholesalePackage format
          setPackages((dealerData.packages || []).map((pkg: any) => {
            return {
              id: pkg.id,
              package_id: pkg.id,
              network: pkg.network,
              size: pkg.size,
              parent_price: (isDealer && pkg.dealer_price && pkg.dealer_price > 0) ? pkg.dealer_price : pkg.price,
              description: pkg.description
            }
          }))
        } else {
          toast.info("No dealer packages available.")
        }
      } else {
        // Sub-agent flow: Get packages from parent's sub_agent_catalog via API
        const response = await fetch("/api/shop/parent-packages", {
          headers: { "Authorization": `Bearer ${token}` }
        })

        if (!response.ok) {
          console.error("API Error:", response.status, response.statusText)
          toast.error(`Failed to fetch packages: ${response.statusText}`)
          return
        }

        const data = await response.json()
        console.log("[BUY-STOCK] Fetched data:", data)

        if (!data.is_sub_agent) {
          toast.error("This page is for sub-agents and dealers only")
          return
        }

        if (data.packages && data.packages.length > 0) {
          console.log("[BUY-STOCK] Loaded packages:", data.packages)
          setPackages(data.packages)
        } else {
          console.log("[BUY-STOCK] No packages available")
          toast.info("No packages available. Your parent shop needs to add packages to their catalog.")
        }
      }

      // Fetch global ordering status
      const settingsResponse = await fetch("/api/shop/public-packages?slug=default", { cache: "no-store" })
      const settingsData = await settingsResponse.json()
      if (settingsData.ordering_enabled !== undefined) {
        setGlobalOrderingEnabled(settingsData.ordering_enabled)
      }
    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const packagesForSelectedNetwork = useMemo(
    () => packages.filter((p) => p.network === selectedNetwork),
    [packages, selectedNetwork]
  )

  const filteredPackages = useMemo(() => {
    const search = searchTerm.toLowerCase()
    return packagesForSelectedNetwork
      .filter((pkg) => !search || pkg.size.toLowerCase().includes(search))
      .sort((a, b) => extractSizeValue(a.size) - extractSizeValue(b.size))
  }, [packagesForSelectedNetwork, searchTerm])

  const meta = NETWORK_META[selectedNetwork] || NETWORK_META.MTN

  const handleBuyClick = (pkg: WholesalePackage) => {
    if (walletBalance < (pkg.parent_price || 0)) {
      toast.error(`Insufficient balance. You need GHS ${(pkg.parent_price || 0).toFixed(2)} but have GHS ${Math.max(0, walletBalance || 0).toFixed(2)}`)
      return
    }
    setSelectedPackageForPurchase(pkg)
    purchaseDismissedRef.current = false
    setPurchaseModal({ state: "phone" })
  }

  const handlePhoneNumberSubmit = async (phoneNumber: string) => {
    if (!selectedPackageForPurchase) {
      toast.error("Error: Missing package information")
      return
    }

    setPurchaseModal({ state: "processing" })

    try {
      setPurchasing(selectedPackageForPurchase.id)

      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Please log in")
        setPurchasing(null)
        setPurchaseModal(null)
        return
      }

      if (!shopId) {
        toast.error("Shop information not found")
        setPurchasing(null)
        setPurchaseModal(null)
        return
      }

      const pkg = selectedPackageForPurchase

      // Create shop order
      const orderResponse = await fetch("/api/shop/orders/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          shop_id: shopId,
          customer_email: session.user?.email || "sub-agent@datagod.com",
          customer_phone: phoneNumber,
          customer_name: `${session.user?.user_metadata?.first_name || ""} ${session.user?.user_metadata?.last_name || ""}`.trim() || "Sub-Agent",
          shop_package_id: pkg.id,
          package_id: pkg.package_id || pkg.id, // Fallback to id if package_id missing
          network: pkg.network,
          volume_gb: pkg.size,
          base_price: pkg.parent_price,
          profit_amount: 0,
          total_price: pkg.parent_price,
          is_stock_purchase: true,
        }),
      })

      const orderData = await orderResponse.json()

      if (!orderResponse.ok) {
        console.error("[BUY-STOCK] Order creation failed:", orderData)
        if (!purchaseDismissedRef.current) setPurchaseModal({ state: "failed", message: orderData.error || `Failed to order ${pkg.network} ${pkg.size}` })
        return
      }

      const orderId = orderData.order?.id
      console.log("[BUY-STOCK] Order created successfully:", orderData)

      // Deduct from wallet
      const debitResponse = await fetch("/api/wallet/debit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          amount: pkg.parent_price,
          orderId: orderId,
          description: `Purchase: ${pkg.network} ${pkg.size}`,
        }),
      })

      const debitData = await debitResponse.json()
      if (!debitResponse.ok) {
        console.error("[BUY-STOCK] Wallet debit failed:", debitData)
        if (!purchaseDismissedRef.current) setPurchaseModal({ state: "failed", message: debitData.error || "Failed to deduct from wallet" })
        return
      }

      // Update local wallet balance
      setWalletBalance(debitData.newBalance || 0)

      toast.success(`Successfully purchased ${pkg.network} ${pkg.size}!`)

      // Customer already dismissed the sheet before this resolved -- the
      // order still went through, but don't reopen a view they already closed.
      if (purchaseDismissedRef.current) return
      setPurchaseModal({
        state: "success",
        summary: {
          packageLabel: `${pkg.network} ${pkg.size}`,
          amount: pkg.parent_price,
          newBalance: debitData.newBalance,
        },
      })
    } catch (error) {
      console.error("[BUY-STOCK] Purchase error:", error)
      if (!purchaseDismissedRef.current) setPurchaseModal({ state: "failed", message: error instanceof Error ? error.message : "Purchase failed" })
    } finally {
      setPurchasing(null)
    }
  }

  const handleCancelPurchase = () => {
    purchaseDismissedRef.current = true
    setPurchaseModal(null)
    setSelectedPackageForPurchase(null)
  }

  const handleDismissPurchase = () => {
    purchaseDismissedRef.current = true
    setPurchaseModal(null)
    setSelectedPackageForPurchase(null)
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  if (userRole !== "sub_agent") {
    return (
      <DashboardLayout>
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertDescription>
            This page is for sub-agents only. Regular shop owners order directly from admin.
          </AlertDescription>
        </Alert>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="relative mx-auto max-w-5xl space-y-5 px-2 pb-16 sm:px-4 md:px-8">
        {!globalOrderingEnabled && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-center text-sm font-bold text-destructive shadow-md">
            The system is currently in maintenance mode. Data package purchases are temporarily disabled.
          </div>
        )}

        <DashboardHeroBanner title="Buy Data" subtitle="Purchase data packages at your parent shop's wholesale prices" icon={ShoppingCart}>
          <div className="shrink-0 rounded-2xl border border-white/20 bg-white/10 px-4 py-2.5 text-right">
            <p className="flex items-center justify-end gap-1 text-[10px] font-bold uppercase tracking-wide text-white/70"><Wallet className="h-3 w-3" /> Balance</p>
            <p className="text-lg font-black text-white">GHS {Math.max(0, walletBalance || 0).toFixed(2)}</p>
          </div>
        </DashboardHeroBanner>

        {/* Network picker */}
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {NETWORK_ORDER.map((net) => {
            const m = NETWORK_META[net]
            const isSelected = selectedNetwork === net
            const isLive = packages.some((p) => p.network === net)
            const logo = getNetworkLogo(net)
            return (
              <button
                key={net}
                onClick={() => setSelectedNetwork(net)}
                className={`relative flex flex-col items-center gap-1.5 rounded-2xl border-2 bg-card p-2.5 sm:p-4 transition ${
                  isSelected ? `${m.border} shadow-sm` : "border-border hover:border-[#1b388b]/30"
                }`}
              >
                {isSelected && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-success text-white">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                )}
                {logo ? (
                  net === "Telecel" ? (
                    <span className="grid h-9 w-9 sm:h-10 sm:w-10 place-items-center rounded-full bg-muted">
                      <img src={logo} alt={m.label} className="h-7 w-7 sm:h-8 sm:w-8 object-contain" />
                    </span>
                  ) : (
                    <span className="block h-9 w-9 sm:h-10 sm:w-10 overflow-hidden rounded-full bg-card">
                      <img src={logo} alt={m.label} className="h-full w-full object-cover" />
                    </span>
                  )
                ) : (
                  <span className={`flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-full text-sm font-extrabold ${m.className}`}>
                    {m.avatar}
                  </span>
                )}
                <span className="text-xs sm:text-sm font-bold text-foreground">{m.label}</span>
                <span className="flex items-center gap-1 text-[10px] sm:text-xs font-semibold text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" /> {isLive ? "Live" : "No Packages"}
                </span>
              </button>
            )
          })}
        </div>

        {/* Search + view toggle */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search packages..."
              className="rounded-2xl border-border bg-card pl-10"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex overflow-hidden rounded-2xl bg-muted p-1">
            <button
              onClick={() => setViewMode("grid")}
              className={`flex items-center justify-center rounded-xl px-3 py-2 transition ${viewMode === "grid" ? "bg-foreground text-background" : "text-muted-foreground"}`}
            >
              <Grid3x3 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`flex items-center justify-center rounded-xl px-3 py-2 transition ${viewMode === "list" ? "bg-foreground text-background" : "text-muted-foreground"}`}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Packages */}
        {viewMode === "grid" ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            {filteredPackages.map((pkg) => (
              <div key={pkg.id} className={`overflow-hidden rounded-2xl ${meta.className}`}>
                <div className="p-4 pb-6 sm:p-5 sm:pb-8">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-xs font-extrabold">
                      {meta.avatar}
                    </span>
                    <span className="rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-bold">{meta.badge}</span>
                  </div>
                  <p className="mt-3 text-2xl sm:text-3xl font-extrabold">
                    {pkg.size.toString().replace(/[^0-9]/g, "")}GB
                  </p>
                  <p className="text-sm sm:text-base font-bold opacity-90">GHS {(pkg.parent_price || 0).toFixed(2)}</p>
                  {pkg.description && (
                    <p className="mt-1.5 text-[11px] opacity-80">• {pkg.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleBuyClick(pkg)}
                  disabled={purchasing === pkg.id || walletBalance < pkg.parent_price || !globalOrderingEnabled}
                  className="flex w-full items-center justify-center gap-2 bg-black/20 py-3 text-sm font-bold disabled:opacity-50"
                >
                  {purchasing === pkg.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShoppingCart className="h-4 w-4" />
                  )}
                  {purchasing === pkg.id ? "Processing..." : walletBalance < pkg.parent_price ? "Insufficient Balance" : "Buy Now"}
                </button>
              </div>
            ))}
            {filteredPackages.length === 0 && (
              <p className="col-span-2 py-8 text-center text-sm text-muted-foreground">
                No {meta.label} packages available. Your parent shop needs to add packages to their catalog.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[500px] text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-foreground">Size</th>
                  <th className="px-4 py-3 text-left font-semibold text-foreground">Price</th>
                  <th className="px-4 py-3 text-left font-semibold text-foreground">Description</th>
                  <th className="px-4 py-3 text-left font-semibold text-foreground">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredPackages.map((pkg) => (
                  <tr key={pkg.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-semibold text-foreground whitespace-nowrap">{pkg.size.toString().replace(/[^0-9]/g, "")}GB</td>
                    <td className="px-4 py-3 font-bold text-foreground whitespace-nowrap">GHS {(pkg.parent_price || 0).toFixed(2)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{pkg.description || "-"}</td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        onClick={() => handleBuyClick(pkg)}
                        disabled={purchasing === pkg.id || walletBalance < pkg.parent_price || !globalOrderingEnabled}
                      >
                        {purchasing === pkg.id ? <Loader2 className="h-3 w-3 animate-spin" /> : walletBalance < pkg.parent_price ? "No Balance" : "Buy"}
                      </Button>
                    </td>
                  </tr>
                ))}
                {filteredPackages.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No {meta.label} packages available. Your parent shop needs to add packages to their catalog.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Showing {filteredPackages.length} of {packagesForSelectedNetwork.length} {meta.label} packages
        </p>
      </div>

      {/* Purchase sheet -- one persistent bottom sheet for phone entry ->
          processing -> success/failed, matching the storefront checkout
          pattern instead of a phone popup handing off to a separate
          success popup. */}
      {purchaseModal && (
        <PurchaseSheet
          modal={purchaseModal}
          packageName={selectedPackageForPurchase
            ? `${selectedPackageForPurchase.network} ${selectedPackageForPurchase.size} (GHS ${(selectedPackageForPurchase.parent_price || 0).toFixed(2)})`
            : "Data Package"
          }
          network={selectedPackageForPurchase?.network}
          onSubmitPhone={handlePhoneNumberSubmit}
          onCancel={handleCancelPurchase}
          onDismiss={handleDismissPurchase}
          accentColor="#1b388b"
          renderSuccess={(modal) => (
            <div className="px-5 pb-6 pt-2 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
                <CheckCircle2 className="w-9 h-9 text-success" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">Purchase successful!</h3>
                <p className="text-sm text-muted-foreground mt-1">Your data package has been ordered and will be delivered shortly.</p>
              </div>
              <div className="text-left p-4 rounded-2xl bg-muted/40 border border-border space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Package</span><span className="font-medium">{modal.summary?.packageLabel}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold">GHS {Number(modal.summary?.amount || 0).toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">New Balance</span><span className="font-bold">GHS {Number(modal.summary?.newBalance || 0).toFixed(2)}</span></div>
              </div>
              <Button onClick={handleDismissPurchase} className="w-full rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
                Done
              </Button>
            </div>
          )}
        />
      )}
    </DashboardLayout>
  )
}
