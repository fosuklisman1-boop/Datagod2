"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { supabase } from "@/lib/supabase"
import { packageService } from "@/lib/database"
import { shopService } from "@/lib/shop-service"
import { AlertCircle, ArrowLeft, Check, Search, Package } from "lucide-react"
import { toast } from "sonner"

interface AdminPackage {
  id: string
  network: string
  size: string
  price: number
  description?: string
  is_active: boolean
}

interface CatalogItem {
  package_id: string
  wholesale_margin: number
}

export default function AddToCatalogPage() {
  const { user } = useAuth()
  const router = useRouter()
  const [shop, setShop] = useState<any>(null)
  const [allPackages, setAllPackages] = useState<AdminPackage[]>([])
  const [existingCatalog, setExistingCatalog] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [networkFilter, setNetworkFilter] = useState<string>("all")
  const [margins, setMargins] = useState<Record<string, string>>({})

  // Get unique networks for filtering
  const networks = [...new Set(allPackages.map(p => p.network))]

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    try {
      setLoading(true)
      if (!user?.id) return

      // Get shop
      const userShop = await shopService.getShop(user.id)
      setShop(userShop)

      if (!userShop) {
        setLoading(false)
        return
      }

      // Get existing catalog items (may fail if table doesn't exist yet)
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token

        if (token) {
          const response = await fetch("/api/shop/sub-agent-catalog", {
            headers: { "Authorization": `Bearer ${token}` }
          })
          const data = await response.json()
          if (data.catalog) {
            setExistingCatalog(data.catalog.map((c: any) => ({
              package_id: c.package_id,
              wholesale_margin: c.wholesale_margin
            })))
            // Pre-fill margins for existing items
            const existingMargins: Record<string, string> = {}
            data.catalog.forEach((c: any) => {
              existingMargins[c.package_id] = c.wholesale_margin.toString()
            })
            setMargins(existingMargins)
          }
        }
      } catch (catalogError) {
        console.error("Error loading catalog (table may not exist yet):", catalogError)
        // Continue anyway - catalog table might not exist yet
      }

      // Get all admin packages
      console.log("Fetching admin packages...")
      const packages = await packageService.getPackages()
      console.log("Fetched packages:", packages?.length || 0)
      
      if (packages && packages.length > 0) {
        setAllPackages(packages.filter((p: AdminPackage) => p.is_active))
      } else {
        console.log("No packages returned from packageService")
        toast.error("No packages found. Admin needs to add packages first.")
      }

    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load packages")
    } finally {
      setLoading(false)
    }
  }

  const handleAddToCatalog = async (pkg: AdminPackage) => {
    const marginStr = margins[pkg.id]
    if (!marginStr) {
      toast.error("Please enter a margin first")
      return
    }

    const margin = parseFloat(marginStr)
    if (isNaN(margin) || margin < 0) {
      toast.error("Please enter a valid margin (0 or greater)")
      return
    }

    try {
      setSaving(pkg.id)
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      if (!token) {
        toast.error("Not authenticated")
        return
      }

      const response = await fetch("/api/shop/sub-agent-catalog", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          package_id: pkg.id,
          wholesale_margin: margin
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to add to catalog")
      }

      toast.success(data.action === "updated" ? "Margin updated!" : "Added to catalog!")
      
      // Update local state
      setExistingCatalog(prev => {
        const exists = prev.find(c => c.package_id === pkg.id)
        if (exists) {
          return prev.map(c => c.package_id === pkg.id ? { ...c, wholesale_margin: margin } : c)
        }
        return [...prev, { package_id: pkg.id, wholesale_margin: margin }]
      })

    } catch (error: any) {
      console.error("Error adding to catalog:", error)
      toast.error(error.message || "Failed to add to catalog")
    } finally {
      setSaving(null)
    }
  }

  const isInCatalog = (packageId: string) => {
    return existingCatalog.some(c => c.package_id === packageId)
  }

  // Filter packages
  const filteredPackages = allPackages.filter(pkg => {
    const matchesSearch = 
      pkg.network.toLowerCase().includes(searchQuery.toLowerCase()) ||
      pkg.size.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesNetwork = networkFilter === "all" || pkg.network === networkFilter
    return matchesSearch && matchesNetwork
  })

  // Group by network
  const packagesByNetwork = filteredPackages.reduce((acc, pkg) => {
    if (!acc[pkg.network]) {
      acc[pkg.network] = []
    }
    acc[pkg.network].push(pkg)
    return acc
  }, {} as Record<string, AdminPackage[]>)

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-600" />
        </div>
      </DashboardLayout>
    )
  }

  if (!shop) {
    return (
      <DashboardLayout>
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            You need to create a shop first.
          </AlertDescription>
        </Alert>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push("/dashboard/sub-agent-catalog")}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Add Packages to Catalog</h1>
            <p className="text-gray-500">
              Select packages and set your wholesale margin for sub-agents
            </p>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row gap-4">
              {/* Search */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search packages..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              {/* Network Filter */}
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant={networkFilter === "all" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setNetworkFilter("all")}
                >
                  All Networks
                </Button>
                {networks.map(network => (
                  <Button
                    key={network}
                    variant={networkFilter === network ? "default" : "outline"}
                    size="sm"
                    onClick={() => setNetworkFilter(network)}
                  >
                    {network}
                  </Button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Info */}
        <Alert className="bg-blue-50 border-blue-200">
          <Package className="h-4 w-4 text-blue-600" />
          <AlertDescription className="text-blue-800">
            <strong>How it works:</strong> Enter your margin for each package. Your sub-agents will pay 
            <strong> Admin Price + Your Margin</strong> as their wholesale cost.
          </AlertDescription>
        </Alert>

        {/* Packages by Network */}
        {Object.keys(packagesByNetwork).length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-gray-500">
              <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No packages found matching your search.</p>
            </CardContent>
          </Card>
        ) : (
          Object.entries(packagesByNetwork).map(([network, packages]) => (
            <Card key={network}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Badge variant="outline" className="text-lg px-3 py-1">
                    {network}
                  </Badge>
                  <span className="text-sm text-gray-500 font-normal">
                    {packages.length} package{packages.length !== 1 ? "s" : ""}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {packages.map((pkg) => {
                    const inCatalog = isInCatalog(pkg.id)
                    const marginValue = margins[pkg.id] || ""
                    const wholesalePrice = marginValue 
                      ? pkg.price + parseFloat(marginValue || "0") 
                      : null

                    return (
                      <div
                        key={pkg.id}
                        className={`p-4 rounded-lg border transition-colors ${
                          inCatalog 
                            ? "bg-green-50 border-green-200" 
                            : "bg-white border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                          {/* Package Info */}
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{pkg.size}</span>
                              {inCatalog && (
                                <Badge className="bg-green-500 text-white">
                                  <Check className="h-3 w-3 mr-1" />
                                  In Catalog
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-gray-500 mt-1">
                              Admin Base Price: <span className="font-medium">GHS {pkg.price.toFixed(2)}</span>
                            </p>
                          </div>

                          {/* Margin Input */}
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1">
                              <span className="text-sm text-gray-500">+</span>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="Margin"
                                value={marginValue}
                                onChange={(e) => setMargins(prev => ({
                                  ...prev,
                                  [pkg.id]: e.target.value
                                }))}
                                className="w-24"
                              />
                            </div>

                            {wholesalePrice !== null && !isNaN(wholesalePrice) && (
                              <div className="text-sm">
                                <span className="text-gray-500">= </span>
                                <span className="font-bold text-violet-600">
                                  GHS {wholesalePrice.toFixed(2)}
                                </span>
                              </div>
                            )}

                            <Button
                              size="sm"
                              variant={inCatalog ? "outline" : "default"}
                              className={inCatalog ? "" : "bg-violet-600 hover:bg-violet-700"}
                              onClick={() => handleAddToCatalog(pkg)}
                              disabled={saving === pkg.id || !marginValue}
                            >
                              {saving === pkg.id 
                                ? "Saving..." 
                                : inCatalog 
                                  ? "Update" 
                                  : "Add"
                              }
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          ))
        )}

        {/* Back Button */}
        <div className="flex justify-center pt-4">
          <Button
            variant="outline"
            onClick={() => router.push("/dashboard/sub-agent-catalog")}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Catalog
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}
