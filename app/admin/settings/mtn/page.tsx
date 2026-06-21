"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Settings, Loader2, AlertCircle, CheckCircle, Zap, WifiOff, Wallet, FileText } from "lucide-react"
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
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel">("sykes")
  const [syncingPackages, setSyncingPackages] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [bisdelCategories, setBisdelCategories] = useState<string[]>([])
  const [bisdelCategory, setBisdelCategory] = useState<string>("")
  const [syncingBisdel, setSyncingBisdel] = useState(false)
  const [savingBisdelCategory, setSavingBisdelCategory] = useState(false)

  useEffect(() => {
    if (adminLoading) return

    if (!isAdmin) return // useAdminProtected handles redirect

    loadSettings()
    loadBalance()
    loadProvider()
    loadBisdelCatalog()

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

  const handleMTNProviderChange = async (provider: "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel") => {
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
                </div>

                {/* Low Balance Alerts */}
                {(balance.balances.sykes.is_low || balance.balances.datakazina.is_low || balance.balances.xpress?.is_low || balance.balances.eazyghdata?.is_low || balance.balances.bisdel?.is_low) && (
                  <Alert className="border-border bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertDescription className="text-warning">

                      {balance.balances.sykes.alert && <p>• {balance.balances.sykes.alert}</p>}
                      {balance.balances.datakazina.alert && <p>• {balance.balances.datakazina.alert}</p>}
                      {balance.balances.xpress?.alert && <p>• {balance.balances.xpress.alert}</p>}
                      {balance.balances.eazyghdata?.alert && <p>• {balance.balances.eazyghdata.alert}</p>}
                      {balance.balances.bisdel?.alert && <p>• {balance.balances.bisdel.alert}</p>}
                      <p className="mt-1 font-medium">SMS alert has been sent to admin.</p>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex justify-between text-sm text-muted-foreground p-3 bg-muted/40 rounded">
                  <span>Alert Threshold:</span>
                  <span className="font-medium">₵{balance.threshold}</span>
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

              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
