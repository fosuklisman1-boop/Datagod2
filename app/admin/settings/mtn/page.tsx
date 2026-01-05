"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Settings, Loader2, AlertCircle, CheckCircle, Zap, WifiOff, Wallet } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"

interface MTNSettings {
  enabled: boolean
  updated_at: string
}

interface MTNBalance {
  balance: number
  currency: string
  threshold: number
  is_low: boolean
  alert: string | null
}

export default function MTNSettingsPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  
  const [settings, setSettings] = useState<MTNSettings | null>(null)
  const [balance, setBalance] = useState<MTNBalance | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [loadingBalance, setLoadingBalance] = useState(true)
  const [toggling, setToggling] = useState(false)

  useEffect(() => {
    if (!isAdmin && !adminLoading) {
      router.push("/")
      return
    }

    if (isAdmin && !adminLoading) {
      loadSettings()
      loadBalance()
      
      // Refresh balance every 30 seconds
      const balanceInterval = setInterval(loadBalance, 30000)
      return () => clearInterval(balanceInterval)
    }
  }, [isAdmin, adminLoading, router])

  const loadSettings = async () => {
    try {
      setLoadingSettings(true)
      const response = await fetch("/api/admin/settings/mtn-auto-fulfillment", {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("authToken")}`,
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
      const response = await fetch("/api/admin/fulfillment/mtn-balance", {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("authToken")}`,
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
      const response = await fetch("/api/admin/settings/mtn-auto-fulfillment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("authToken")}`,
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
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <div className="space-y-1">
                    <p className="font-medium text-gray-900">
                      {settings?.enabled ? "🟢 ENABLED" : "⚪ DISABLED"}
                    </p>
                    <p className="text-sm text-gray-600">
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
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="font-medium text-blue-900 mb-2">🟢 When Enabled</p>
                    <ul className="space-y-1 text-blue-800 text-xs">
                      <li>✓ Orders auto-fulfill immediately</li>
                      <li>✓ Faster customer delivery</li>
                      <li>✓ MTN API handles all requests</li>
                      <li>✓ Tracked in MTN Fulfillment tab</li>
                    </ul>
                  </div>

                  <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                    <p className="font-medium text-amber-900 mb-2">⚪ When Disabled</p>
                    <ul className="space-y-1 text-amber-800 text-xs">
                      <li>✓ Orders go to Downloads tab</li>
                      <li>✓ Admin controls fulfillment</li>
                      <li>✓ Manual review before execution</li>
                      <li>✓ Extra layer of safety</li>
                    </ul>
                  </div>
                </div>

                {settings?.updated_at && (
                  <p className="text-xs text-gray-500">
                    Last updated: {new Date(settings.updated_at).toLocaleString()}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* MTN Wallet Balance */}
        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              MTN Wallet Balance
            </CardTitle>
            <CardDescription>
              Real-time wallet balance for fulfilling orders
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingBalance ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : balance ? (
              <div className="space-y-4">
                <div className="flex items-baseline gap-2 p-4 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-lg border border-emerald-200">
                  <span className="text-4xl font-bold text-emerald-900">
                    ₵{balance.balance.toFixed(2)}
                  </span>
                  <span className="text-sm text-emerald-700">GHS</span>
                </div>

                {balance.is_low && (
                  <Alert className="border-orange-200 bg-orange-50">
                    <AlertCircle className="h-4 w-4 text-orange-600" />
                    <AlertDescription className="text-orange-700">
                      {balance.alert}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex justify-between text-sm text-gray-600 p-3 bg-gray-50 rounded">
                  <span>Alert Threshold:</span>
                  <span className="font-medium">₵{balance.threshold}</span>
                </div>

                <Button
                  onClick={loadBalance}
                  variant="outline"
                  className="w-full"
                >
                  Refresh Balance
                </Button>
              </div>
            ) : (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Unable to fetch balance. Check MTN API connection.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Info Cards */}
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="bg-blue-50 border-blue-200">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-blue-600" />
                How It Works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2 text-blue-900">
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

          <Card className="bg-amber-50 border-amber-200">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-amber-600" />
                Pro Tip
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2 text-amber-900">
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
