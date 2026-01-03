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
import { shopService } from "@/lib/shop-service"
import { AlertCircle, ArrowLeft, Check, Search, Package } from "lucide-react"
import { toast } from "sonner"

interface AdminPackage {
  id: string
  network: string
  size: string
  price: number
  description?: string
  active: boolean
  _original_admin_price?: number  // For sub-agents: admin base price
  _parent_wholesale_margin?: number  // For sub-agents: parent's margin
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
  const [sellingPrices, setSellingPrices] = useState<Record<string, string>>({})

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
            // Pre-fill selling prices for existing items
            const existingPrices: Record<string, string> = {}
            data.catalog.forEach((c: any) => {
              // Use parent_wholesale_price if available, fallback to package.price, default to 0
              let basePrice = 0;
              if (typeof c.parent_wholesale_price === 'number') {
                basePrice = c.parent_wholesale_price;
              } else if (c.package && typeof c.package.price === 'number') {
                basePrice = c.package.price;
              }
              // Only set if basePrice is a valid number
              if (!isNaN(basePrice) && !isNaN(c.wholesale_margin)) {
                existingPrices[c.package_id] = (basePrice + c.wholesale_margin).toFixed(2);
              } else {
                existingPrices[c.package_id] = '';
              }
            });
            setSellingPrices(existingPrices);
          }
        }
      } catch (catalogError) {
        console.error("Error loading catalog (table may not exist yet):", catalogError)
        // Continue anyway - catalog table might not exist yet
      }

      // Get parent's packages (what this sub-agent can buy at)
      // For sub-agents: use parent-packages API which shows parent's wholesale prices
      // For regular shops: use admin-packages API (fallback)
      console.log("Fetching available packages...")
      try {
        let apiEndpoint = "/api/shop/admin-packages"
        
        // Check if this is a sub-agent
        if (userShop?.parent_shop_id) {
          apiEndpoint = "/api/shop/parent-packages"
          console.log("Sub-agent detected, using parent-packages API")
        }
        
        const pkgResponse = await fetch(apiEndpoint)
        const pkgData = await pkgResponse.json()
        console.log("Fetched packages:", pkgData.packages?.length || 0)
        
        if (pkgData.packages && pkgData.packages.length > 0) {
          // Always use admin-set price (_original_admin_price) as main price for 'Your Cost'
          setAllPackages(pkgData.packages.filter((p: AdminPackage) => p.active).map((p: any) => {
            let price = 0;
            if (typeof p._original_admin_price === 'number' && !isNaN(p._original_admin_price)) {
              price = p._original_admin_price;
            }
            return { ...p, price };
          }))
        } else {
          console.log("No packages returned from API")
          toast.error("No packages found. Admin needs to add packages first.")
        }
      } catch (pkgError) {
        console.error("Error fetching packages:", pkgError)
        toast.error("Failed to load packages")
      }

    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load packages")
    } finally {
      setLoading(false)
    }
  }

  const handleAddToCatalog = async (pkg: AdminPackage) => {
    const sellingPriceStr = sellingPrices[pkg.id]
    if (!sellingPriceStr) {
      toast.error("Please enter a selling price first")
      return
    }

    const sellingPrice = parseFloat(sellingPriceStr)
    if (isNaN(sellingPrice) || sellingPrice <= 0) {
      toast.error("Please enter a valid selling price")
      return
    }

    // For parents: margin = selling_price - admin price (shown as pkg.price)
    // This is the parent's profit margin
    const margin = sellingPrice - pkg.price
    // Parent's selling price (admin price + parent margin) becomes the base for sub-agents
    const parentPrice = sellingPrice
    if (margin < 0) {
      toast.error("Selling price must be higher than base price")
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
          wholesale_margin: margin,
          parent_price: parentPrice
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
            <strong>How it works:</strong> Enter the selling price for each package. Your sub-agents will pay 
            this price as their wholesale cost.
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
                    const sellingPriceValue = sellingPrices[pkg.id] || ""
                    let basePrice = typeof pkg.price === 'number' ? pkg.price : 0;
                    if (isNaN(basePrice)) basePrice = 0;
                    let margin = null;
                    if (sellingPriceValue && !isNaN(parseFloat(sellingPriceValue))) {
                      margin = parseFloat(sellingPriceValue) - basePrice;
                    }

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
                              Your Cost: <span className="font-medium">GHS {typeof basePrice === 'number' && !isNaN(basePrice) ? basePrice.toFixed(2) : '0.00'}</span>
                            </p>
                          </div>

                          {/* Selling Price Input */}
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1">
                              <span className="text-sm text-gray-500">Sell at:</span>
                              <Input
                                type="number"
                                step="0.01"
                                min={pkg.price}
                                placeholder="Selling Price"
                                value={sellingPriceValue}
                                onChange={(e) => setSellingPrices(prev => ({
                                  ...prev,
                                  [pkg.id]: e.target.value
                                }))}
                                className="w-28"
                              />
                            </div>

                            {margin !== null && !isNaN(margin) && margin >= 0 && (
                              <div className="text-sm">
                                <span className="text-gray-500">Profit: </span>
                                <span className="font-bold text-green-600">
                                  GHS {typeof margin === 'number' && !isNaN(margin) ? margin.toFixed(2) : '0.00'}
                                </span>
                              </div>
                            )}

                            <Button
                              size="sm"
                              variant={inCatalog ? "outline" : "default"}
                              className={inCatalog ? "" : "bg-violet-600 hover:bg-violet-700"}
                              onClick={() => handleAddToCatalog(pkg)}
                              disabled={saving === pkg.id || !sellingPriceValue || (margin !== null && margin < 0)}
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
