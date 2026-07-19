"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Settings, Loader2, AlertCircle, CheckCircle, Zap, WifiOff, Wallet, FileText, ToggleLeft, ToggleRight, ShieldCheck, Bell } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import Link from "next/link"

interface MTNSettings {
  enabled: boolean
  updated_at: string
}

interface ProviderBalance {
  balance: number | null
  currency: string
  is_low: boolean
  is_active: boolean
  alert: string | null
}

interface MTNBalance {
  balances: {
    sykes: ProviderBalance
    datakazina: ProviderBalance
    xpress: ProviderBalance
    eazyghdata: ProviderBalance
    bisdel: ProviderBalance
    codecraft: ProviderBalance
  }
  threshold: number
  active_provider: string
  timestamp: string
}

export default function MTNSettingsPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()

  const [settings, setSettings] = useState<MTNSettings | null>(null)
  const [balance, setBalance] = useState<MTNBalance | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [loadingBalance, setLoadingBalance] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [gateSettings, setGateSettings] = useState<{ enabled: boolean; updated_at?: string } | null>(null)
  const [gateToggling, setGateToggling] = useState(false)
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft">("sykes")
  const [syncingPackages, setSyncingPackages] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [bisdelCategories, setBisdelCategories] = useState<string[]>([])
  const [bisdelCategory, setBisdelCategory] = useState<string>("")
  const [syncingBisdel, setSyncingBisdel] = useState(false)
  const [savingBisdelCategory, setSavingBisdelCategory] = useState(false)

  // AT auto-fulfillment toggle (CodeCraft — iShare, Telecel, BigTime)
  const [atFulfillmentEnabled, setAtFulfillmentEnabled] = useState(true)
  const [loadingAtFulfillment, setLoadingAtFulfillment] = useState(true)
  const [togglingAtFulfillment, setTogglingAtFulfillment] = useState(false)

  // MTN whitelist toggle
  const [whitelistEnabled, setWhitelistEnabled] = useState(true)
  const [loadingWhitelist, setLoadingWhitelist] = useState(true)
  const [togglingWhitelist, setTogglingWhitelist] = useState(false)

  // Balance alert threshold
  const [threshold, setThreshold] = useState<number>(500)
  const [thresholdInput, setThresholdInput] = useState<string>("500")
  const [savingThreshold, setSavingThreshold] = useState(false)

  // Fallback provider
  type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft"
  const [fallbackEnabled, setFallbackEnabled] = useState(false)
  const [fallbackProvider, setFallbackProvider] = useState<MTNProviderName>("eazyghdata")
  const [savingFallback, setSavingFallback] = useState(false)

  // Per-network provider selectors (Telecel / AT-iShare / AT-BigTime)
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft"
  const [telecelProvider, setTelecelProvider] = useState<NonMTNProvider>("codecraft")
  const [atIshareProvider, setAtIshareProvider] = useState<NonMTNProvider>("codecraft")
  const [atBigtimeProvider, setAtBigtimeProvider] = useState<NonMTNProvider>("codecraft")
  const [savingNetworkProvider, setSavingNetworkProvider] = useState<string | null>(null)

  useEffect(() => {
    if (adminLoading) return

    if (!isAdmin) return // useAdminProtected handles redirect

    loadSettings()
    loadGateSettings()
    loadBalance()
    loadProvider()
    loadBisdelCatalog()
    loadAtFulfillmentSetting()
    loadWhitelistSetting()
    loadNetworkProvider("telecel", setTelecelProvider)
    loadNetworkProvider("at_ishare", setAtIshareProvider)
    loadNetworkProvider("at_bigtime", setAtBigtimeProvider)
    loadThreshold()
    loadFallbackProvider()

    // Refresh balance every 30 seconds
    const balanceInterval = setInterval(loadBalance, 30000)
    return () => clearInterval(balanceInterval)
  }, [isAdmin, adminLoading])

  const loadSettings = async () => {
    try {
      setLoadingSettings(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        router.push("/login")
        return
      }
      const response = await fetch("/api/admin/settings/mtn-auto-fulfillment", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setSettings({
          enabled: data.enabled,
          updated_at: data.updated_at,
        })
      } else {
        toast.error("Failed to load MTN settings")
      }
    } catch (error) {
      console.error("Error loading settings:", error)
      toast.error("Error loading MTN settings")
    } finally {
      setLoadingSettings(false)
    }
  }

  const loadGateSettings = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        router.push("/login")
        return
      }
      const response = await fetch("/api/admin/settings/mtn-registration-gate", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setGateSettings({
          enabled: data.enabled,
          updated_at: data.updated_at,
        })
      } else {
        toast.error("Failed to load registration gate settings")
      }
    } catch (error) {
      console.error("Error loading gate settings:", error)
      toast.error("Error loading registration gate settings")
    }
  }

  const loadBalance = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        return
      }
      const response = await fetch("/api/admin/fulfillment/mtn-balance", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setBalance(data)
      }
    } catch (error) {
      console.error("Error loading balance:", error)
    } finally {
      setLoadingBalance(false)
    }
  }

  const handleToggle = async () => {
    if (!settings) return

    try {
      setToggling(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }
      const response = await fetch("/api/admin/settings/mtn-auto-fulfillment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          enabled: !settings.enabled,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setSettings({
          enabled: data.enabled,
          updated_at: new Date().toISOString(),
        })
        toast.success(data.message)
      } else {
        toast.error("Failed to update setting")
      }
    } catch (error) {
      console.error("Error updating setting:", error)
      toast.error("Error updating MTN setting")
    } finally {
      setToggling(false)
    }
  }

  const handleGateToggle = async () => {
    if (!gateSettings) return

    try {
      setGateToggling(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }
      const response = await fetch("/api/admin/settings/mtn-registration-gate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          enabled: !gateSettings.enabled,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setGateSettings({
          enabled: data.enabled,
          updated_at: new Date().toISOString(),
        })
        toast.success(data.message)
      } else {
        toast.error("Failed to update setting")
      }
    } catch (error) {
      console.error("Error updating gate setting:", error)
      toast.error("Error updating registration gate setting")
    } finally {
      setGateToggling(false)
    }
  }

  const loadProvider = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const response = await fetch("/api/admin/settings/mtn-provider", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setMtnProvider(data.provider || "sykes")
      }
    } catch (error) {
      console.error("Error loading provider:", error)
    }
  }

  const loadBisdelCatalog = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setBisdelCategories(data.categories || [])
        setBisdelCategory(data.selected_category || "")
      }
    } catch (error) {
      console.error("Error loading Bisdel catalog:", error)
    }
  }

  const handleSyncEazyGhDataPackages = async () => {
    setSyncingPackages(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/admin/fulfillment/eazyghdata-packages", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })

      if (response.ok) {
        const data = await response.json()
        toast.success(`Synced ${data.count} EazyGhData packages`)
      } else {
        const err = await response.json()
        toast.error(err.error || "Failed to sync packages")
      }
    } catch (error) {
      console.error("Error syncing packages:", error)
      toast.error("Error syncing EazyGhData packages")
    } finally {
      setSyncingPackages(false)
    }
  }

  const handleSyncBisdelProducts = async () => {
    setSyncingBisdel(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setBisdelCategories(data.categories || [])
        toast.success(`Synced ${data.count} Bisdel products`)
      } else {
        const err = await response.json()
        toast.error(err.error || "Failed to sync products")
      }
    } catch (error) {
      console.error("Error syncing Bisdel products:", error)
      toast.error("Error syncing Bisdel products")
    } finally {
      setSyncingBisdel(false)
    }
  }

  const handleSelectBisdelCategory = async (category: string) => {
    setSavingBisdelCategory(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ category }),
      })
      if (response.ok) {
        setBisdelCategory(category)
        toast.success(`Bisdel category set to ${category}`)
      } else {
        toast.error("Failed to set category")
      }
    } catch (error) {
      console.error("Error setting Bisdel category:", error)
      toast.error("Error setting Bisdel category")
    } finally {
      setSavingBisdelCategory(false)
    }
  }

  const loadFallbackProvider = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch("/api/admin/settings/mtn-fallback-provider", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const d = await res.json()
        setFallbackEnabled(d.enabled)
        setFallbackProvider(d.provider || "eazyghdata")
      }
    } catch (e) { console.error("Error loading fallback provider:", e) }
  }

  const handleSaveFallbackProvider = async (enabled: boolean, provider: MTNProviderName) => {
    setSavingFallback(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch("/api/admin/settings/mtn-fallback-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled, provider }),
      })
      if (res.ok) {
        setFallbackEnabled(enabled)
        setFallbackProvider(provider)
        toast.success(enabled ? `Fallback set to ${provider}` : "Fallback provider disabled")
      } else {
        toast.error("Failed to save fallback setting")
      }
    } catch (e) {
      console.error("Error saving fallback provider:", e)
      toast.error("Error saving fallback provider")
    } finally {
      setSavingFallback(false)
    }
  }

  const handleMTNProviderChange = async (provider: "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft") => {
    setSavingProvider(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/admin/settings/mtn-provider", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ provider }),
      })

      if (response.ok) {
        const data = await response.json()
        setMtnProvider(provider)
        toast.success(data.message)
        // Reload balance to show updated active provider
        loadBalance()
      } else {
        toast.error("Failed to update provider")
      }
    } catch (error) {
      console.error("Error updating provider:", error)
      toast.error("Error updating MTN provider")
    } finally {
      setSavingProvider(false)
    }
  }

  const loadThreshold = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/settings/balance-threshold", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) {
        const d = await res.json()
        setThreshold(d.threshold)
        setThresholdInput(String(d.threshold))
      }
    } catch (e) { console.error("Error loading threshold:", e) }
  }

  const handleSaveThreshold = async () => {
    const value = parseInt(thresholdInput, 10)
    if (isNaN(value) || value < 0) { toast.error("Enter a valid number"); return }
    setSavingThreshold(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/balance-threshold", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ threshold: value }),
      })
      if (!res.ok) throw new Error("Failed to save")
      setThreshold(value)
      toast.success(`Alert threshold set to ₵${value}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setSavingThreshold(false) }
  }

  const loadNetworkProvider = async (network: string, setter: (v: any) => void) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`/api/admin/settings/network-provider?network=${network}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) { const d = await res.json(); setter(d.provider || "codecraft") }
    } catch (e) { console.error(`Error loading ${network} provider:`, e) }
  }

  const handleNetworkProviderChange = async (network: string, provider: string, setter: (v: any) => void) => {
    setSavingNetworkProvider(network)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/network-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ network, provider }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      setter(provider)
      toast.success(`Provider updated`)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setSavingNetworkProvider(null) }
  }

  const loadAtFulfillmentSetting = async () => {
    try {
      setLoadingAtFulfillment(true)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/settings/auto-fulfillment", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) { const d = await res.json(); setAtFulfillmentEnabled(d.setting?.enabled ?? true) }
    } catch (e) { console.error("Error loading AT fulfillment setting:", e) }
    finally { setLoadingAtFulfillment(false) }
  }

  const toggleAtFulfillment = async () => {
    try {
      setTogglingAtFulfillment(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/auto-fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled: !atFulfillmentEnabled }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      const d = await res.json()
      setAtFulfillmentEnabled(d.setting.enabled)
      toast.success(d.message)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setTogglingAtFulfillment(false) }
  }

  const loadWhitelistSetting = async () => {
    try {
      setLoadingWhitelist(true)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/settings/mtn-whitelist", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) { const d = await res.json(); setWhitelistEnabled(d.setting?.enabled ?? true) }
    } catch (e) { console.error("Error loading whitelist setting:", e) }
    finally { setLoadingWhitelist(false) }
  }

  const toggleWhitelist = async () => {
    try {
      setTogglingWhitelist(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/mtn-whitelist", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled: !whitelistEnabled }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      const d = await res.json()
      setWhitelistEnabled(d.setting.enabled)
      toast.success(d.message)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setTogglingWhitelist(false) }
  }

  if (!isAdmin || adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Settings className="h-6 w-6" />
          <h1 className="text-3xl font-bold">MTN Fulfillment Settings</h1>
        </div>

        {/* Auto-Fulfillment Toggle */}
        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Auto-Fulfillment Mode
            </CardTitle>
            <CardDescription>
              Control whether MTN orders are automatically fulfilled or queued for manual download
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {loadingSettings ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      {settings?.enabled ? "🟢 ENABLED" : "⚪ DISABLED"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {settings?.enabled
                        ? "Orders are automatically fulfilled via MTN API"
                        : "Orders appear in admin download queue for manual fulfillment"}
                    </p>
                  </div>
                  <Button
                    onClick={handleToggle}
                    disabled={toggling}
                    variant={settings?.enabled ? "destructive" : "default"}
                    className="min-w-[120px]"
                  >
                    {toggling ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Updating...
                      </>
                    ) : settings?.enabled ? (
                      <>
                        <WifiOff className="h-4 w-4 mr-2" />
                        Turn Off
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4 mr-2" />
                        Turn On
                      </>
                    )}
                  </Button>
                </div>

                <div className="grid md:grid-cols-2 gap-4 text-sm">
                  <div className="p-4 bg-primary/5 rounded-lg border border-primary/20">
                    <p className="font-medium text-foreground mb-2">🟢 When Enabled</p>
                    <ul className="space-y-1 text-primary text-xs">
                      <li>✓ Orders auto-fulfill immediately</li>
                      <li>✓ Faster customer delivery</li>
                      <li>✓ MTN API handles all requests</li>
                      <li>✓ Tracked in MTN Fulfillment tab</li>
                    </ul>
                  </div>

                  <div className="p-4 bg-warning/10 rounded-lg border border-border">
                    <p className="font-medium text-warning mb-2">⚪ When Disabled</p>
                    <ul className="space-y-1 text-warning text-xs">
                      <li>✓ Orders go to Downloads tab</li>
                      <li>✓ Admin controls fulfillment</li>
                      <li>✓ Manual review before execution</li>
                      <li>✓ Extra layer of safety</li>
                    </ul>
                  </div>
                </div>

                {settings?.updated_at && (
                  <p className="text-xs text-muted-foreground">
                    Last updated: {new Date(settings.updated_at).toLocaleString()}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Registration Gate Toggle */}
        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5" />
              Registration Gate
            </CardTitle>
            <CardDescription>
              Hold MTN orders for numbers not yet registered with MTN. Enable ONLY after the registry
              back-catalog has been marked registered — otherwise every MTN order will hold.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg">
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  {gateSettings?.enabled
                    ? "🟢 ENABLED — unregistered numbers are held"
                    : "⚪ DISABLED — orders flow as before"}
                </p>
              </div>
              <Button
                onClick={handleGateToggle}
                disabled={gateToggling || !gateSettings}
                variant={gateSettings?.enabled ? "destructive" : "default"}
                className="min-w-[120px]"
              >
                {gateToggling ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : gateSettings?.enabled ? (
                  <>
                    <WifiOff className="h-4 w-4 mr-2" />
                    Turn Off
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4 mr-2" />
                    Turn On
                  </>
                )}
              </Button>
            </div>

            {gateSettings?.updated_at && (
              <p className="text-xs text-muted-foreground">
                Last updated: {new Date(gateSettings.updated_at).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>

        {/* MTN Wallet Balances - DUAL PROVIDER */}
        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              MTN Wallet Balances
            </CardTitle>
            <CardDescription>
              Real-time wallet balances for both MTN providers
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingBalance ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : balance ? (
              <div className="space-y-4">
                {/* Quint Balance Display */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  {/* Sykes Balance */}
                  <div className={`p-4 rounded-lg border-2 transition-all ${balance.balances.sykes.is_active
                    ? 'bg-primary/5 border-border shadow-md'
                    : 'bg-muted/40 border-border'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">Sykes API</span>
                      {balance.balances.sykes.is_active && (
                        <Badge className="bg-primary">Active</Badge>
                      )}
                    </div>
                    {balance.balances.sykes.balance !== null ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-3xl font-bold ${balance.balances.sykes.is_low ? 'text-warning' : 'text-success'
                            }`}>
                            ₵{balance.balances.sykes.balance.toFixed(2)}
                          </span>
                          <span className="text-sm text-muted-foreground">GHS</span>
                        </div>
                        {balance.balances.sykes.is_low && (
                          <p className="text-xs text-warning mt-2">⚠️ Low balance</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unable to fetch</p>
                    )}
                  </div>

                  {/* DataKazina Balance */}
                  <div className={`p-4 rounded-lg border-2 transition-all ${balance.balances.datakazina.is_active
                    ? 'bg-success/10 border-border shadow-md'
                    : 'bg-muted/40 border-border'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">DataKazina API</span>
                      {balance.balances.datakazina.is_active && (
                        <Badge className="bg-success">Active</Badge>
                      )}
                    </div>
                    {balance.balances.datakazina.balance !== null ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-3xl font-bold ${balance.balances.datakazina.is_low ? 'text-warning' : 'text-success'
                            }`}>
                            ₵{balance.balances.datakazina.balance.toFixed(2)}
                          </span>
                          <span className="text-sm text-muted-foreground">GHS</span>
                        </div>
                        {balance.balances.datakazina.is_low && (
                          <p className="text-xs text-warning mt-2">⚠️ Low balance</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unable to fetch</p>
                    )}
                  </div>

                  {/* Xpress Balance */}
                  <div className={`p-4 rounded-lg border-2 transition-all ${balance.balances.xpress?.is_active
                    ? 'bg-primary/10 border-border shadow-md'
                    : 'bg-muted/40 border-border'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">Xpress API</span>
                      {balance.balances.xpress?.is_active && (
                        <Badge className="bg-primary">Active</Badge>
                      )}
                    </div>
                    {balance.balances.xpress?.balance !== null && balance.balances.xpress?.balance !== undefined ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-3xl font-bold ${balance.balances.xpress.is_low ? 'text-warning' : 'text-success'
                            }`}>
                            ₵{balance.balances.xpress.balance.toFixed(2)}
                          </span>
                          <span className="text-sm text-muted-foreground">GHS</span>
                        </div>
                        {balance.balances.xpress.is_low && (
                          <p className="text-xs text-warning mt-2">⚠️ Low balance</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unable to fetch</p>
                    )}
                  </div>

                  {/* EazyGhData Balance */}
                  <div className={`p-4 rounded-lg border-2 transition-all ${balance.balances.eazyghdata?.is_active
                    ? 'bg-primary/10 border-border shadow-md'
                    : 'bg-muted/40 border-border'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">EazyGhData</span>
                      {balance.balances.eazyghdata?.is_active && (
                        <Badge className="bg-primary">Active</Badge>
                      )}
                    </div>
                    {balance.balances.eazyghdata?.balance !== null && balance.balances.eazyghdata?.balance !== undefined ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-3xl font-bold ${balance.balances.eazyghdata.is_low ? 'text-warning' : 'text-success'
                            }`}>
                            ₵{balance.balances.eazyghdata.balance.toFixed(2)}
                          </span>
                          <span className="text-sm text-muted-foreground">GHS</span>
                        </div>
                        {balance.balances.eazyghdata.is_low && (
                          <p className="text-xs text-warning mt-2">⚠️ Low balance</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unable to fetch</p>
                    )}
                  </div>

                  {/* Bisdel Balance */}
                  <div className={`p-4 rounded-lg border-2 transition-all ${balance.balances.bisdel?.is_active
                    ? 'bg-indigo-50 border-border shadow-md'
                    : 'bg-muted/40 border-border'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">Bisdel</span>
                      {balance.balances.bisdel?.is_active && (
                        <Badge className="bg-indigo-600">Active</Badge>
                      )}
                    </div>
                    {balance.balances.bisdel?.balance !== null && balance.balances.bisdel?.balance !== undefined ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-3xl font-bold ${balance.balances.bisdel.is_low ? 'text-orange-600' : 'text-emerald-900'
                            }`}>
                            ₵{balance.balances.bisdel.balance.toFixed(2)}
                          </span>
                          <span className="text-sm text-muted-foreground">GHS</span>
                        </div>
                        {balance.balances.bisdel.is_low && (
                          <p className="text-xs text-orange-600 mt-2">⚠️ Low balance</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unable to fetch</p>
                    )}
                  </div>

                  {/* CodeCraft Balance */}
                  <div className={`p-4 rounded-lg border-2 transition-all ${balance.balances.codecraft?.is_active
                    ? 'bg-violet-50 border-border shadow-md'
                    : 'bg-muted/40 border-border'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">CodeCraft</span>
                      {balance.balances.codecraft?.is_active && (
                        <Badge className="bg-violet-600">Active</Badge>
                      )}
                    </div>
                    {balance.balances.codecraft?.balance !== null && balance.balances.codecraft?.balance !== undefined ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-3xl font-bold ${balance.balances.codecraft.is_low ? 'text-orange-600' : 'text-emerald-900'}`}>
                            ₵{balance.balances.codecraft.balance.toFixed(2)}
                          </span>
                          <span className="text-sm text-muted-foreground">GHS</span>
                        </div>
                        {balance.balances.codecraft.is_low && (
                          <p className="text-xs text-orange-600 mt-2">⚠️ Low balance</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unable to fetch</p>
                    )}
                  </div>
                </div>

                {/* Low Balance Alerts */}
                {(balance.balances.sykes.is_low || balance.balances.datakazina.is_low || balance.balances.xpress?.is_low || balance.balances.eazyghdata?.is_low || balance.balances.bisdel?.is_low || balance.balances.codecraft?.is_low) && (
                  <Alert className="border-border bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertDescription className="text-warning">

                      {balance.balances.sykes.alert && <p>• {balance.balances.sykes.alert}</p>}
                      {balance.balances.datakazina.alert && <p>• {balance.balances.datakazina.alert}</p>}
                      {balance.balances.xpress?.alert && <p>• {balance.balances.xpress.alert}</p>}
                      {balance.balances.eazyghdata?.alert && <p>• {balance.balances.eazyghdata.alert}</p>}
                      {balance.balances.bisdel?.alert && <p>• {balance.balances.bisdel.alert}</p>}
                      {balance.balances.codecraft?.alert && <p>• {balance.balances.codecraft.alert}</p>}
                      <p className="mt-1 font-medium">SMS alert has been sent to admin.</p>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="p-3 bg-muted/40 rounded space-y-2">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-muted-foreground" />
                    <Label className="text-sm font-medium">Alert Threshold</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">₵</span>
                    <Input
                      type="number"
                      min={0}
                      value={thresholdInput}
                      onChange={(e) => setThresholdInput(e.target.value)}
                      className="w-32 h-8 text-sm"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSaveThreshold}
                      disabled={savingThreshold || thresholdInput === String(threshold)}
                    >
                      {savingThreshold ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                    </Button>
                    <span className="text-xs text-muted-foreground">SMS + email alert fires when any balance drops below this value</span>
                  </div>
                </div>

                <Button
                  onClick={loadBalance}
                  variant="outline"
                  className="w-full"
                >
                  Refresh Balances
                </Button>
              </div>
            ) : (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Unable to fetch balances. Check MTN API connections.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* MTN Provider Selection */}
        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              MTN Fulfillment Provider
            </CardTitle>
            <CardDescription>
              Select which MTN API provider to use for order fulfillment
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Choose your preferred MTN data provider. Switching only affects new orders.
              </p>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {/* Sykes Option */}
                <button
                  onClick={() => handleMTNProviderChange("sykes")}
                  disabled={savingProvider || mtnProvider === "sykes"}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${mtnProvider === "sykes"
                      ? "bg-primary/5 border-primary shadow-md"
                      : "bg-card border-border hover:border-border"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-foreground">Sykes API</span>
                    {mtnProvider === "sykes" && (
                      <Badge className="bg-primary">Active</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Current/Legacy provider</p>
                </button>

                {/* DataKazina Option */}
                <button
                  onClick={() => handleMTNProviderChange("datakazina")}
                  disabled={savingProvider || mtnProvider === "datakazina"}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${mtnProvider === "datakazina"
                      ? "bg-success/10 border-success shadow-md"
                      : "bg-card border-border hover:border-border"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-foreground">DataKazina API</span>
                    {mtnProvider === "datakazina" && (
                      <Badge className="bg-success">Active</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Alternative MTN provider</p>
                </button>

                {/* Xpress Option */}
                <button
                  onClick={() => handleMTNProviderChange("xpress")}
                  disabled={savingProvider || mtnProvider === "xpress"}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${mtnProvider === "xpress"
                      ? "bg-primary border-primary shadow-md"
                      : "bg-card border-border hover:border-border"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-foreground">Xpress API</span>
                    {mtnProvider === "xpress" && (
                      <Badge className="bg-primary">Active</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Batch-enabled provider</p>
                </button>

                {/* EazyGhData Option */}
                <button
                  onClick={() => handleMTNProviderChange("eazyghdata")}
                  disabled={savingProvider || mtnProvider === "eazyghdata"}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${mtnProvider === "eazyghdata"
                      ? "bg-primary border-primary shadow-md"
                      : "bg-card border-border hover:border-border"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-foreground">EazyGhData</span>
                    {mtnProvider === "eazyghdata" && (
                      <Badge className="bg-primary">Active</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Package-based provider</p>
                </button>

                {/* Bisdel Option */}
                <button
                  onClick={() => handleMTNProviderChange("bisdel")}
                  disabled={savingProvider || mtnProvider === "bisdel"}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${mtnProvider === "bisdel"
                      ? "bg-indigo-50 border-indigo-500 shadow-md"
                      : "bg-card border-border hover:border-border"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-foreground">Bisdel</span>
                    {mtnProvider === "bisdel" && (
                      <Badge className="bg-indigo-600">Active</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Category-based provider</p>
                </button>

                {/* CodeCraft Option */}
                <button
                  onClick={() => handleMTNProviderChange("codecraft")}
                  disabled={savingProvider || mtnProvider === "codecraft"}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${mtnProvider === "codecraft"
                      ? "bg-violet-50 border-violet-500 shadow-md"
                      : "bg-card border-border hover:border-border"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-foreground">CodeCraft</span>
                    {mtnProvider === "codecraft" && (
                      <Badge className="bg-violet-600">Active</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">MTN via CodeCraft API</p>
                </button>
              </div>

              {/* EazyGhData Package Sync */}
              {mtnProvider === "eazyghdata" && (
                <div className="p-4 bg-primary/10 rounded-lg border border-primary">
                  <p className="text-sm font-medium text-primary mb-2">EazyGhData Package Mapping</p>
                  <p className="text-xs text-primary mb-3">
                    EazyGhData requires a package_id UUID per GB size. Sync packages to keep the mapping up to date.
                  </p>
                  <Button
                    onClick={handleSyncEazyGhDataPackages}
                    disabled={syncingPackages}
                    variant="outline"
                    size="sm"
                    className="border-primary text-primary hover:bg-primary/20"
                  >
                    {syncingPackages ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Syncing...
                      </>
                    ) : (
                      "Sync EazyGhData Packages"
                    )}
                  </Button>
                </div>
              )}

              {/* Bisdel Product Sync + Category */}
              {mtnProvider === "bisdel" && (
                <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-200 space-y-3">
                  <p className="text-sm font-medium text-indigo-900">Bisdel Products &amp; Category</p>
                  <p className="text-xs text-indigo-700">
                    Bisdel matches each order by GB within a single category. Sync products, then choose the
                    category orders are fulfilled from. Orders fail until a category is selected.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      onClick={handleSyncBisdelProducts}
                      disabled={syncingBisdel}
                      variant="outline"
                      size="sm"
                      className="border-indigo-400 text-indigo-800 hover:bg-indigo-100"
                    >
                      {syncingBisdel ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Syncing...
                        </>
                      ) : (
                        "Sync Bisdel Products"
                      )}
                    </Button>

                    <select
                      value={bisdelCategory}
                      onChange={(e) => handleSelectBisdelCategory(e.target.value)}
                      disabled={savingBisdelCategory || bisdelCategories.length === 0}
                      className="px-3 py-2 text-sm rounded-md border border-indigo-300 bg-white text-indigo-900 disabled:opacity-50"
                    >
                      <option value="" disabled>
                        {bisdelCategories.length === 0 ? "Sync products first" : "Select a category"}
                      </option>
                      {bisdelCategories.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    {bisdelCategory && (
                      <span className="text-xs text-indigo-700">Active: <strong>{bisdelCategory}</strong></span>
                    )}
                  </div>
                </div>
              )}

              {savingProvider && (
                <div className="flex items-center justify-center p-4 bg-muted/40 rounded-lg">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  <span className="text-sm text-muted-foreground">Updating provider...</span>
                </div>
              )}

              <Alert className="border-border bg-warning/10">
                <AlertCircle className="h-4 w-4 text-warning" />
                <AlertDescription className="text-warning text-sm">
                  <strong>Note:</strong> Switching providers only affects NEW orders.
                  In-flight orders will continue with their original provider.
                </AlertDescription>
              </Alert>
            </div>
          </CardContent>
        </Card>

        {/* Fallback Provider */}
        <Card className="border-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Zap className="h-5 w-5" />
                  Fallback Provider
                </CardTitle>
                <CardDescription>
                  Automatically retry with a second provider when the primary fails
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {savingFallback && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                <Switch
                  checked={fallbackEnabled}
                  onCheckedChange={(v) => handleSaveFallbackProvider(v, fallbackProvider)}
                  disabled={savingFallback}
                />
              </div>
            </div>
          </CardHeader>
          {fallbackEnabled && (
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                When the primary provider (<strong>{mtnProvider}</strong>) returns a failure, the system will immediately retry the same order with the selected fallback. The fallback must differ from the primary.
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {(["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft"] as MTNProviderName[]).map((p) => {
                  const isPrimary = p === mtnProvider
                  const isSelected = p === fallbackProvider
                  return (
                    <button
                      key={p}
                      onClick={() => !isPrimary && handleSaveFallbackProvider(true, p)}
                      disabled={savingFallback || isPrimary || isSelected}
                      className={`p-3 rounded-lg border-2 transition-all text-left ${
                        isPrimary
                          ? "opacity-30 cursor-not-allowed bg-muted border-border"
                          : isSelected
                          ? "bg-primary/5 border-primary shadow-md"
                          : "bg-card border-border hover:border-muted-foreground cursor-pointer"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-sm capitalize">{p === "eazyghdata" ? "EazyGhData" : p === "codecraft" ? "CodeCraft" : p === "datakazina" ? "DataKazina" : p.charAt(0).toUpperCase() + p.slice(1)}</span>
                        {isSelected && <Badge className="bg-primary text-[10px] px-1 py-0">Fallback</Badge>}
                        {isPrimary && <Badge variant="outline" className="text-[10px] px-1 py-0">Primary</Badge>}
                      </div>
                    </button>
                  )
                })}
              </div>
              <Alert className="mt-4 border-border bg-muted/40">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  The fallback only triggers on API-level failures (provider down, rejected). Registration holds and already-completed orders are not retried.
                </AlertDescription>
              </Alert>
            </CardContent>
          )}
        </Card>

        {/* Per-Network Provider Selector — helper to avoid repeating JSX for each network */}
        {(["telecel", "at_ishare", "at_bigtime"] as const).map((netKey) => {
          const networkLabel = netKey === "telecel" ? "Telecel" : netKey === "at_ishare" ? "AT - iShare" : "AT - BigTime"
          const current = netKey === "telecel" ? telecelProvider : netKey === "at_ishare" ? atIshareProvider : atBigtimeProvider
          const setter = netKey === "telecel" ? setTelecelProvider : netKey === "at_ishare" ? setAtIshareProvider : setAtBigtimeProvider
          const isSaving = savingNetworkProvider === netKey
          const providers: { value: NonMTNProvider; label: string; sub: string }[] = [
            { value: "codecraft", label: "CodeCraft", sub: "Default AT/Telecel API" },
            { value: "datakazina", label: "DataKazina", sub: "Multi-network provider" },
            { value: "xpress", label: "Xpress", sub: "Batch-enabled provider" },
            { value: "eazyghdata", label: "EazyGhData", sub: "Package-based provider" },
          ]
          return (
            <Card key={netKey} className="border-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  {networkLabel} Fulfillment Provider
                </CardTitle>
                <CardDescription>
                  Select which provider fulfills <strong>{networkLabel}</strong> orders
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {providers.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => handleNetworkProviderChange(netKey, p.value, setter)}
                      disabled={isSaving || current === p.value}
                      className={`p-4 rounded-lg border-2 transition-all text-left ${
                        current === p.value
                          ? "bg-primary/5 border-primary shadow-md"
                          : "bg-card border-border hover:border-border"
                      } ${isSaving ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-foreground text-sm">{p.label}</span>
                        {current === p.value && <Badge className="bg-primary text-xs">Active</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">{p.sub}</p>
                    </button>
                  ))}
                </div>
                {isSaving && (
                  <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Updating...
                  </div>
                )}
                <Alert className="mt-3 border-border bg-warning/10">
                  <AlertCircle className="h-4 w-4 text-warning" />
                  <AlertDescription className="text-warning text-xs">
                    Only affects new orders. In-flight orders continue with their original provider.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          )
        })}

        {/* AT Networks Auto-Fulfillment (CodeCraft) */}
        <Card className="border-2">
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {atFulfillmentEnabled
                    ? <ToggleRight className="h-5 w-5 text-success" />
                    : <ToggleLeft className="h-5 w-5 text-muted-foreground" />}
                  AT Networks Auto-Fulfillment
                </CardTitle>
                <CardDescription className="mt-1">
                  Automatically fulfill AT-iShare, Telecel, and AT-BigTime orders via Code Craft API
                </CardDescription>
              </div>
              <div className="flex items-center gap-3">
                {loadingAtFulfillment ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    {togglingAtFulfillment && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <span className={`text-sm font-medium ${atFulfillmentEnabled ? 'text-success' : 'text-muted-foreground'}`}>
                      {atFulfillmentEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <Switch checked={atFulfillmentEnabled} onCheckedChange={toggleAtFulfillment} disabled={togglingAtFulfillment} />
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mb-3">
              <span className="text-sm text-muted-foreground">Affected networks:</span>
              <Badge className="bg-primary/10 text-primary border border-primary">AT - iShare</Badge>
              <Badge className="bg-red-100 text-red-800 border border-red-200">Telecel</Badge>
              <Badge className="bg-primary/10 text-primary border border-primary">AT - BigTime</Badge>
            </div>
            <Alert className={atFulfillmentEnabled ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'}>
              <AlertCircle className={`h-4 w-4 ${atFulfillmentEnabled ? 'text-success' : 'text-warning'}`} />
              <AlertDescription className={atFulfillmentEnabled ? 'text-success' : 'text-warning'}>
                {atFulfillmentEnabled
                  ? <><strong>ON:</strong> Orders are automatically fulfilled via Code Craft API on payment confirmation.</>
                  : <><strong>OFF:</strong> Orders are queued in the admin download queue for manual processing.</>}
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* MTN Whitelist Verification */}
        <Card className="border-2">
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className={`h-5 w-5 ${whitelistEnabled ? 'text-success' : 'text-muted-foreground'}`} />
                  MTN Whitelist Verification
                </CardTitle>
                <CardDescription className="mt-1">
                  Check Xpress &amp; Codecraft whitelists before fulfilling MTN orders
                </CardDescription>
              </div>
              <div className="flex items-center gap-3">
                {loadingWhitelist ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    {togglingWhitelist && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <span className={`text-sm font-medium ${whitelistEnabled ? 'text-success' : 'text-muted-foreground'}`}>
                      {whitelistEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <Switch checked={whitelistEnabled} onCheckedChange={toggleWhitelist} disabled={togglingWhitelist} />
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Alert className={whitelistEnabled ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'}>
              <ShieldCheck className={`h-4 w-4 ${whitelistEnabled ? 'text-success' : 'text-warning'}`} />
              <AlertDescription className={whitelistEnabled ? 'text-success' : 'text-warning'}>
                {whitelistEnabled
                  ? <><strong>ON:</strong> MTN orders are verified against Xpress → Codecraft. Numbers not yet enabled are held and retried every 24h for up to 72h.</>
                  : <><strong>OFF:</strong> MTN orders skip whitelist verification and go straight to the active fulfillment provider.</>}
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Info Cards */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* View Fulfillment Logs Card */}
          <Card className="bg-primary/10 border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                Fulfillment Logs
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-3 text-primary">
              <p>
                View all MTN orders sent to the API, their status, and retry failed orders.
              </p>
              <Link href="/admin/mtn-logs">
                <Button className="w-full bg-primary hover:bg-primary">
                  <FileText className="h-4 w-4 mr-2" />
                  View MTN Fulfillment Logs
                </Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="bg-primary/5 border-primary/20">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-primary" />
                How It Works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2 text-foreground">
              <p>
                <strong>Enabled:</strong> Orders bypass the download queue and are sent directly to
                MTN API for instant fulfillment.
              </p>
              <p>
                <strong>Disabled:</strong> Orders appear in your Download queue for review and
                manual fulfillment through the admin panel.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid md:grid-cols-1 gap-4">
          <Card className="bg-warning/10 border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-warning" />
                Pro Tip
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2 text-warning">
              <p>
                Start with <strong>Disabled</strong> to test your setup. Once confident, enable
                auto-fulfillment for faster order processing.
              </p>
              <p>Monitor balance to avoid failed orders due to insufficient funds.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}
