"use client"

import { useState, useEffect, useMemo, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { useUserRole } from "@/hooks/use-user-role"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Grid3x3, List, Search, Loader2, ShieldCheck, ExternalLink, RefreshCw, ShoppingCart, CheckCircle2, XCircle } from "lucide-react"
import { PhoneNumberModal } from "@/components/phone-number-modal"
import { SuccessModal } from "@/components/success-modal"
import { BulkOrdersForm } from "@/components/bulk-orders-form"
import { networkLogoService } from "@/lib/shop-service"
import { supabase } from "@/lib/supabase"
import { applyPriceAdjustmentsToPackages } from "@/lib/price-adjustment-service"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "@/lib/phone-format"
import { toast } from "sonner"

interface Package {
  id: string
  network: string
  size: string
  price: number
  description?: string
}

// Real brand tokens (same ones used on the dashboard's Send Data Bundles
// row and Network Health card) -- not arbitrary per-page colors. BigTime
// has no dedicated token (single-usage accent), so it stays a plain violet.
// Keys match the real packages.network values exactly (verified against the
// live DB: "AT - iShare" / "AT - BigTime", WITH spaces around the hyphen --
// not "AT-iShare"/"AT-BigTime", which silently matched zero rows).
const NETWORK_META: Record<string, { label: string; avatar: string; badge: string; className: string; border: string }> = {
  MTN: { label: "MTN", avatar: "M", badge: "MTN", className: "bg-mtn text-mtn-foreground", border: "border-mtn" },
  Telecel: { label: "Telecel", avatar: "T", badge: "Telecel", className: "bg-telecel text-telecel-foreground", border: "border-telecel" },
  "AT - iShare": { label: "AT iShare", avatar: "A", badge: "AT-iS", className: "bg-at text-at-foreground", border: "border-at" },
  "AT - BigTime": { label: "AT BigTime", avatar: "A", badge: "AT-BT", className: "bg-violet-600 text-white", border: "border-violet-600" },
}
const NETWORK_ORDER = Object.keys(NETWORK_META)

function DataPackagesPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, loading: authLoading } = useAuth()
  const { isDealer } = useUserRole()
  const [orderMode, setOrderMode] = useState<"single" | "bulk">(searchParams.get("mode") === "bulk" ? "bulk" : "single")
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [selectedNetwork, setSelectedNetwork] = useState("MTN")
  const [searchTerm, setSearchTerm] = useState("")
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})
  const [packages, setPackages] = useState<Package[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [purchasing, setPurchasing] = useState<string | null>(null)
  const [wallet, setWallet] = useState<{ balance: number } | null>(null)
  const [phoneModalOpen, setPhoneModalOpen] = useState(false)
  const [selectedPackageForPurchase, setSelectedPackageForPurchase] = useState<Package | null>(null)
  const [verifyWarningOpen, setVerifyWarningOpen] = useState(false)
  const [pendingPhoneNumber, setPendingPhoneNumber] = useState<string | null>(null)
  const [globalOrderingEnabled, setGlobalOrderingEnabled] = useState(true)
  // Whether the beneficiary gets an order-confirmation SMS -- this is real,
  // existing behavior (app/api/orders/purchase already always sent this
  // text); the toggle just makes it optional instead of unconditional.
  const [sendSmsConfirmation, setSendSmsConfirmation] = useState(true)
  const [regCheckOpen, setRegCheckOpen] = useState(false)
  const [regCheckInput, setRegCheckInput] = useState("")
  const [regChecking, setRegChecking] = useState(false)
  const [regResults, setRegResults] = useState<{ phone: string; verified: boolean }[] | null>(null)
  const [successModal, setSuccessModal] = useState<{
    open: boolean
    title: string
    message: string
    details: Array<{ label: string; value: string }>
  }>({ open: false, title: "", message: "", details: [] })
  // Live network->prefix map (admin-editable) for pre-submit validation;
  // falls back to the hardcoded default if the fetch fails.
  const [prefixMap, setPrefixMap] = useState<NetworkPrefixMap>(DEFAULT_NETWORK_PREFIXES)

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    // logos and settings don't need auth — load immediately
    loadNetworkLogos()
    loadGlobalSettings()
    fetch("/api/network-prefixes")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.map) setPrefixMap(d.map) })
      .catch(() => {}) // fall back to defaults silently
  }, [])

  useEffect(() => {
    if (user) {
      loadPackages()
      loadWallet()
    }
  }, [user])

  const loadGlobalSettings = async () => {
    try {
      const response = await fetch("/api/shop/public-packages?slug=default", { cache: "no-store" })
      const data = await response.json()
      if (data.ordering_enabled !== undefined) {
        setGlobalOrderingEnabled(data.ordering_enabled)
      }
    } catch (error) {
      console.error("Error loading global settings:", error)
    }
  }

  const loadWallet = async () => {
    if (!user?.id) return
    try {
      const { data, error } = await supabase.from("wallets").select("balance").eq("user_id", user.id).single()

      if (error && error.code === "PGRST116") {
        const session = await supabase.auth.getSession()
        if (!session.data.session?.access_token) {
          setWallet({ balance: 0 })
          return
        }
        const response = await fetch("/api/wallet/create", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.data.session.access_token}`, "Content-Type": "application/json" },
        })
        if (!response.ok) {
          setWallet({ balance: 0 })
          return
        }
        const result = await response.json()
        setWallet({ balance: result.wallet.balance })
      } else if (error) {
        setWallet({ balance: 0 })
        return
      } else {
        setWallet(data)
      }
    } catch (error) {
      console.error("Error loading wallet:", error)
      setWallet({ balance: 0 })
    }
  }

  const loadNetworkLogos = async () => {
    try {
      const logos = await networkLogoService.getLogosAsObject()
      setNetworkLogos(logos)
    } catch (error) {
      console.error("Error loading network logos:", error)
    }
  }

  const loadPackages = async () => {
    try {
      let userRole = "user"
      if (user) {
        const { data: userData } = await supabase.from("users").select("role").eq("id", user.id).single()
        userRole = userData?.role || "user"
      }

      const { data, error } = await supabase
        .from("packages")
        .select("*, dealer_price")
        .eq("is_available", true)
        .order("network, size")

      if (error) {
        console.error("Error loading packages:", error)
        return
      }

      let processedPackages = data || []
      if (userRole === "dealer") {
        processedPackages = processedPackages.map((pkg: any) => ({
          ...pkg,
          price: pkg.dealer_price && pkg.dealer_price > 0 ? pkg.dealer_price : pkg.price
        }))
      }

      const adjustedPackages = await applyPriceAdjustmentsToPackages(processedPackages)
      setPackages(adjustedPackages)
    } catch (error) {
      console.error("Error loading packages:", error)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const handleRefresh = () => {
    setRefreshing(true)
    loadPackages()
  }

  const getNetworkLogo = (network: string): string => {
    if (networkLogos[network]) return networkLogos[network]
    const normalized = network.charAt(0).toUpperCase() + network.slice(1).toLowerCase()
    if (networkLogos[normalized]) return networkLogos[normalized]
    return ""
  }

  const extractSizeValue = (size: string): number => {
    const normalized = size.trim().toUpperCase()
    const match = normalized.match(/^(\d+)(?:\D|$)/)
    if (!match) return 0
    return parseInt(match[1], 10)
  }

  const handlePurchase = async (pkg: Package) => {
    if (!user) {
      toast.error("Please login first")
      return
    }
    if (!wallet) {
      toast.error("Failed to load wallet")
      return
    }
    if (wallet.balance < (pkg.price || 0)) {
      toast.error(`Insufficient balance. You need GHS ${(pkg.price || 0).toFixed(2)} but have GHS ${Math.max(0, wallet.balance || 0).toFixed(2)}`)
      return
    }
    setSelectedPackageForPurchase(pkg)
    setPhoneModalOpen(true)
  }

  const handlePhoneNumberSubmit = async (phoneNumber: string, skipVerification = false) => {
    if (!selectedPackageForPurchase || !user) {
      toast.error("Error: Missing package or user information")
      return
    }

    const phoneCheck = validatePhoneNumber(phoneNumber, selectedPackageForPurchase.network, prefixMap)
    if (!phoneCheck.isValid) {
      toast.error(phoneCheck.error || "Please enter a valid phone number")
      return
    }

    setPurchasing(selectedPackageForPurchase.id)

    if (!skipVerification && selectedPackageForPurchase.network.toUpperCase() === "MTN") {
      try {
        const verifyRes = await fetch("/api/verify-phone-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: [phoneNumber] }),
        })
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json()
          const verifiedResult = verifyData.results?.[0]?.verified
          if (verifiedResult === false) {
            setPurchasing(null)
            setPhoneModalOpen(false)
            setPendingPhoneNumber(phoneNumber)
            setVerifyWarningOpen(true)
            return
          }
          if (verifiedResult === true) {
            toast.success("Number verified ✓")
          }
        }
      } catch (verifyErr) {
        console.warn("[DATA-PACKAGES] Live verification check failed, proceeding:", verifyErr)
      }
    }

    try {
      setPurchasing(selectedPackageForPurchase.id)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Session expired, please login again")
        setPurchasing(null)
        setPhoneModalOpen(false)
        return
      }

      const response = await fetch("/api/orders/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          packageId: selectedPackageForPurchase.id,
          network: selectedPackageForPurchase.network,
          size: selectedPackageForPurchase.size,
          price: selectedPackageForPurchase.price,
          phoneNumber,
          sendSmsConfirmation,
        }),
      })

      const data = await response.json()
      if (!response.ok) {
        toast.error(data.error || "Purchase failed")
        return
      }

      setWallet({ balance: data.newBalance })
      toast.success(`Successfully purchased ${selectedPackageForPurchase.network} ${selectedPackageForPurchase.size}!`)
      setPhoneModalOpen(false)

      setTimeout(() => {
        setSuccessModal({
          open: true,
          title: "Purchase Successful!",
          message: "Your data package has been ordered and will be delivered shortly.",
          details: [
            { label: "Package", value: `${selectedPackageForPurchase?.network} ${selectedPackageForPurchase?.size}` },
            { label: "Amount", value: `GHS ${(selectedPackageForPurchase?.price || 0).toFixed(2)}` },
            { label: "New Balance", value: `GHS ${(data.newBalance || 0).toFixed(2)}` },
          ],
        })
      }, 100)

      setTimeout(() => router.push("/dashboard/my-orders"), 3500)
    } catch (error) {
      console.error("Purchase error:", error)
      toast.error("An error occurred during purchase")
    } finally {
      setPurchasing(null)
      setSelectedPackageForPurchase(null)
    }
  }

  const handleProceedAfterVerifyWarning = async () => {
    setVerifyWarningOpen(false)
    if (pendingPhoneNumber && selectedPackageForPurchase) {
      const phone = pendingPhoneNumber
      setPendingPhoneNumber(null)
      setPurchasing(selectedPackageForPurchase.id)
      await handlePhoneNumberSubmit(phone, true)
    }
  }

  const handleRegCheck = async () => {
    const phones = regCheckInput.split(/[\n,]/).map(p => p.trim()).filter(Boolean)
    if (phones.length === 0) {
      toast.error("Enter at least one phone number")
      return
    }
    if (phones.length > 100) {
      toast.error("Up to 100 numbers at a time")
      return
    }
    setRegChecking(true)
    setRegResults(null)
    try {
      const res = await fetch("/api/verify-phone-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Check failed")
        return
      }
      setRegResults(data.results || [])
    } catch (err) {
      toast.error("Check failed — please try again")
    } finally {
      setRegChecking(false)
    }
  }

  const packagesForSelectedNetwork = useMemo(
    () => packages.filter((pkg) => pkg.network === selectedNetwork),
    [packages, selectedNetwork]
  )

  const filteredPackages = useMemo(() => {
    const search = searchTerm.toLowerCase()
    return packagesForSelectedNetwork
      .filter((pkg) => !search || pkg.size.toLowerCase().includes(search) || pkg.network.toLowerCase().includes(search))
      .sort((a, b) => extractSizeValue(a.size) - extractSizeValue(b.size))
  }, [packagesForSelectedNetwork, searchTerm])

  const meta = NETWORK_META[selectedNetwork]

  return (
    <DashboardLayout>
      <div className="relative space-y-5 px-2 pb-16 sm:px-4 md:px-8">
        {!globalOrderingEnabled && (
          <Alert className="border-destructive/30 bg-destructive/10 shadow-md">
            <AlertDescription className="text-destructive font-bold text-center">
              The system is currently in maintenance mode. Data package purchases are temporarily disabled.
            </AlertDescription>
          </Alert>
        )}

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
                  isSelected ? `${m.border} shadow-sm` : "border-border hover:border-primary/30"
                }`}
              >
                {isSelected && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-success text-white">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                )}
                {logo ? (
                  <img src={logo} alt={m.label} className="h-9 w-9 sm:h-10 sm:w-10 object-contain" />
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

        {/* MTN-only: real registration check via /api/verify-phone-live */}
        {selectedNetwork === "MTN" && (
          <button
            onClick={() => { setRegCheckOpen(true); setRegResults(null); setRegCheckInput("") }}
            className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-primary/30"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-foreground">Check MTN Number Registration</span>
              <span className="block text-xs text-muted-foreground">Not-registered numbers may be held for MTN's own validation · up to 100 at once</span>
            </span>
            <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        )}

        {/* Single / Bulk Order tabs */}
        <div className="inline-flex w-full rounded-2xl bg-muted p-1">
          <button
            onClick={() => setOrderMode("single")}
            className={`flex-1 rounded-xl py-2.5 text-sm font-bold transition ${orderMode === "single" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            Single
          </button>
          <button
            onClick={() => setOrderMode("bulk")}
            className={`flex-1 rounded-xl py-2.5 text-sm font-bold transition ${orderMode === "bulk" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            Bulk Order
          </button>
        </div>

        {orderMode === "bulk" ? (
          <BulkOrdersForm presetNetwork={selectedNetwork} />
        ) : (
          <>
            {/* Order SMS confirmation — real existing behavior (the purchase
                route already always sent this text); this just makes it
                optional instead of unconditional. */}
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4">
              <div>
                <p className="text-sm font-bold text-foreground">Order SMS confirmation</p>
                <p className="mt-0.5 text-xs text-muted-foreground">The beneficiary gets a text confirming their order.</p>
              </div>
              <Switch checked={sendSmsConfirmation} onCheckedChange={setSendSmsConfirmation} />
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
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : viewMode === "grid" ? (
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
                      <p className="text-sm sm:text-base font-bold opacity-90">GHS {(pkg.price || 0).toFixed(2)}</p>
                      {pkg.description && (
                        <p className="mt-1.5 text-[11px] opacity-80">• {pkg.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handlePurchase(pkg)}
                      disabled={purchasing === pkg.id || !wallet || wallet.balance < pkg.price || !globalOrderingEnabled}
                      className="flex w-full items-center justify-center gap-2 bg-black/20 py-3 text-sm font-bold disabled:opacity-50"
                    >
                      {purchasing === pkg.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ShoppingCart className="h-4 w-4" />
                      )}
                      {purchasing === pkg.id ? "Processing..." : !wallet || wallet.balance < pkg.price ? "Insufficient Balance" : "Buy Now"}
                    </button>
                  </div>
                ))}
                {filteredPackages.length === 0 && (
                  <p className="col-span-2 py-8 text-center text-sm text-muted-foreground">No packages found for {meta.label}</p>
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
                        <td className="px-4 py-3 font-bold text-foreground whitespace-nowrap">GHS {(pkg.price || 0).toFixed(2)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{pkg.description || "-"}</td>
                        <td className="px-4 py-3">
                          <Button
                            size="sm"
                            onClick={() => handlePurchase(pkg)}
                            disabled={purchasing === pkg.id || !wallet || wallet.balance < pkg.price || !globalOrderingEnabled}
                          >
                            {purchasing === pkg.id ? <Loader2 className="h-3 w-3 animate-spin" /> : !wallet || wallet.balance < pkg.price ? "No Balance" : "Buy"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Showing {filteredPackages.length} of {packagesForSelectedNetwork.length} {meta.label} packages
            </p>
          </>
        )}

        {/* Floating refresh FAB */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Refresh packages"
          className="fixed bottom-24 right-4 z-20 flex h-12 w-12 items-center justify-center rounded-full bg-card text-foreground shadow-lg border border-border md:bottom-8 md:right-8"
        >
          <RefreshCw className={`h-5 w-5 ${refreshing ? "animate-spin" : ""}`} />
        </button>

        {/* MTN registration check dialog */}
        <Dialog open={regCheckOpen} onOpenChange={setRegCheckOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Check MTN Number Registration</DialogTitle>
              <DialogDescription>Paste one number per line (or comma-separated), up to 100 at once.</DialogDescription>
            </DialogHeader>
            <Textarea
              placeholder={"0244000000\n0244000001"}
              value={regCheckInput}
              onChange={(e) => setRegCheckInput(e.target.value)}
              rows={5}
            />
            {regResults && (
              <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2">
                {regResults.map((r) => (
                  <div key={r.phone} className="flex items-center justify-between text-sm">
                    <span className="font-mono">{r.phone}</span>
                    {r.verified ? (
                      <span className="flex items-center gap-1 text-success"><CheckCircle2 className="h-3.5 w-3.5" /> Registered</span>
                    ) : (
                      <span className="flex items-center gap-1 text-destructive"><XCircle className="h-3.5 w-3.5" /> Not registered</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setRegCheckOpen(false)}>Close</Button>
              <Button onClick={handleRegCheck} disabled={regChecking}>
                {regChecking ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking...</> : "Check"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <PhoneNumberModal
          open={phoneModalOpen}
          onOpenChange={setPhoneModalOpen}
          onSubmit={handlePhoneNumberSubmit}
          isLoading={purchasing !== null}
          packageName={selectedPackageForPurchase ? `${selectedPackageForPurchase.network} ${selectedPackageForPurchase.size}` : "Data Package"}
        />

        <SuccessModal
          open={successModal.open}
          onClose={() => setSuccessModal({ ...successModal, open: false })}
          title={successModal.title}
          message={successModal.message}
          details={successModal.details}
          actionLabel="View Orders"
          onAction={() => router.push("/dashboard/my-orders")}
        />

        <Dialog open={verifyWarningOpen} onOpenChange={(open) => { if (!open) { setVerifyWarningOpen(false); setPendingPhoneNumber(null) } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Number not yet verified</DialogTitle>
              <DialogDescription>
                This number hasn&apos;t been verified yet. If you proceed, your order will still be processed, but delivery may be delayed until it clears — you&apos;ll receive it automatically once verified.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setVerifyWarningOpen(false); setPendingPhoneNumber(null); setPhoneModalOpen(true) }}>Change number</Button>
              <Button disabled={purchasing !== null} onClick={handleProceedAfterVerifyWarning}>
                {purchasing !== null ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
                ) : (
                  "Proceed anyway"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}

export default function DataPackagesPage() {
  return (
    <Suspense fallback={
      <DashboardLayout>
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    }>
      <DataPackagesPageInner />
    </Suspense>
  )
}
