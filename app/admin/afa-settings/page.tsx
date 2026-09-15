"use client"

import { useState, useEffect } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, AlertCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { useAdminProtected } from "@/hooks/use-admin"

export default function AFASettingsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [price, setPrice] = useState("50.00")
  const [description, setDescription] = useState("")
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [afaProvider, setAfaProvider] = useState<"sykes" | "apexprime">("sykes")
  const [loadingProvider, setLoadingProvider] = useState(true)
  const [savingProvider, setSavingProvider] = useState(false)

  useEffect(() => {
    fetchCurrentPrice()
    loadProviderSetting()
  }, [])

  const fetchCurrentPrice = async () => {
    try {
      setFetching(true)
      setError(null)
      const response = await fetch("/api/afa/price")
      if (!response.ok) throw new Error("Failed to fetch price")

      const data = await response.json()
      setPrice(data.price?.toString() || "50.00")
      setDescription(data.description || "")
    } catch (err) {
      console.error("Error fetching price:", err)
      setError("Failed to load current price")
    } finally {
      setFetching(false)
    }
  }

  const handleUpdatePrice = async (e: React.FormEvent) => {
    e.preventDefault()

    try {
      setLoading(true)
      setError(null)

      const numPrice = parseFloat(price)
      if (isNaN(numPrice) || numPrice <= 0) {
        setError("Price must be a valid positive number")
        return
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setError("Not authenticated")
        return
      }

      const response = await fetch("/api/afa/price", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          price: numPrice,
          description: description,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to update price")
      }

      toast.success("AFA registration price updated successfully")
      await fetchCurrentPrice()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to update price"
      setError(errorMsg)
      toast.error(errorMsg)
    } finally {
      setLoading(false)
    }
  }

  const loadProviderSetting = async () => {
    try {
      setLoadingProvider(true)
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/settings/afa-provider", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (!response.ok) throw new Error("Failed to fetch provider setting")
      const data = await response.json()
      setAfaProvider(data.provider === "apexprime" ? "apexprime" : "sykes")
    } catch (err) {
      console.error("Error fetching AFA provider setting:", err)
    } finally {
      setLoadingProvider(false)
    }
  }

  const handleProviderChange = async (provider: "sykes" | "apexprime") => {
    if (provider === afaProvider || savingProvider) return
    try {
      setSavingProvider(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Not authenticated")
        return
      }
      const response = await fetch("/api/admin/settings/afa-provider", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ provider }),
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to update provider")
      }
      setAfaProvider(provider)
      toast.success(`AFA registrations will now use ${provider === "apexprime" ? "Apex Prime" : "Sykes"}`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to update provider"
      toast.error(errorMsg)
    } finally {
      setSavingProvider(false)
    }
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) {
    return null
  }

  return (
    <DashboardLayout>
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">AFA Registration Settings</h1>
        <p className="text-muted-foreground mt-2">Manage MTN AFA registration pricing</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Registration Provider</CardTitle>
          <CardDescription>
            Choose which provider fulfils new AFA registrations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingProvider ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleProviderChange("sykes")}
                  disabled={savingProvider}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${
                    afaProvider === "sykes" ? "bg-primary/5 border-primary shadow-md" : "bg-card border-border"
                  } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <p className="font-semibold text-sm">Sykes</p>
                  <p className="text-xs text-muted-foreground mt-1">Current default. Registration completes immediately on submission.</p>
                </button>
                <button
                  onClick={() => handleProviderChange("apexprime")}
                  disabled={savingProvider}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${
                    afaProvider === "apexprime" ? "bg-primary/5 border-primary shadow-md" : "bg-card border-border"
                  } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <p className="font-semibold text-sm">Apex Prime</p>
                  <p className="text-xs text-muted-foreground mt-1">Pays from the Main Wallet also used for Apex Prime data orders. Async — stays &quot;processing&quot; until MTN approves.</p>
                </button>
              </div>
              {savingProvider && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />Updating…
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registration Price</CardTitle>
          <CardDescription>
            Set the price for MTN AFA registration. This will be charged from user wallets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {fetching ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <form onSubmit={handleUpdatePrice} className="space-y-4">
              <div>
                <Label htmlFor="price">Price (GHS)</Label>
                <div className="flex gap-2">
                  <Input
                    id="price"
                    type="number"
                    step="0.01"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="flex-1"
                    placeholder="Enter price"
                  />
                  <span className="flex items-center px-3 bg-muted rounded-md font-semibold">
                    GHS
                  </span>
                </div>
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  "Update Price"
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <strong>Current Price:</strong> GHS {parseFloat(price).toFixed(2)}
          </p>
          <p>
            <strong>Currency:</strong> Ghanaian Cedis (GHS)
          </p>
          <p>
            <strong>Storage:</strong> Database (afa_registration_prices table)
          </p>
          <p className="text-muted-foreground">
            Changes to the price will take effect immediately for new registrations.
          </p>
        </CardContent>
      </Card>
    </div>
    </DashboardLayout>
  )
}
