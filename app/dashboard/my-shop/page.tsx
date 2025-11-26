"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { shopService, shopPackageService } from "@/lib/shop-service"
import { packageService } from "@/lib/database"
import { AlertCircle, Check, Copy, ExternalLink, Store, Package, Plus } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

export default function MyShopPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [packages, setPackages] = useState<any[]>([])
  const [allPackages, setAllPackages] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editingShop, setEditingShop] = useState(false)
  const [formData, setFormData] = useState({
    shop_name: "",
    description: "",
    logo_url: "",
  })
  const [addingPackage, setAddingPackage] = useState(false)
  const [selectedPackage, setSelectedPackage] = useState<string>("")
  const [profitMargin, setProfitMargin] = useState<string>("")
  const [dbError, setDbError] = useState<string | null>(null)
  const [selectedNetwork, setSelectedNetwork] = useState<string>("All")

  useEffect(() => {
    if (!user) return
    loadShopData()
  }, [user])

  const loadShopData = async () => {
    try {
      setLoading(true)
      setDbError(null)
      if (!user?.id) return
      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      
      if (userShop) {
        try {
          const shopPkgs = await shopPackageService.getShopPackages(userShop.id)
          setPackages(shopPkgs || [])
        } catch (pkgError: any) {
          console.error("Error loading packages:", pkgError)
          setPackages([])
        }
        
        setFormData({
          shop_name: userShop.shop_name || "",
          description: userShop.description || "",
          logo_url: userShop.logo_url || "",
        })
      }

      try {
        const allPkgs = await packageService.getPackages()
        setAllPackages(allPkgs || [])
      } catch (allPkgError: any) {
        console.error("Error loading all packages:", allPkgError)
        setAllPackages([])
      }
    } catch (error: any) {
      console.error("Error loading shop:", error)
      if (error.message?.includes("relation") || error.message?.includes("not found")) {
        setDbError("Database tables not set up. Please run the SQL schema in Supabase.")
      } else {
        toast.error(error?.message || "Failed to load shop data")
      }
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateShop = async () => {
    if (!shop || !formData.shop_name.trim()) {
      toast.error("Shop name is required")
      return
    }

    try {
      const updated = await shopService.updateShop(shop.id, {
        shop_name: formData.shop_name,
        description: formData.description,
        logo_url: formData.logo_url,
      })
      setShop(updated)
      setEditingShop(false)
      toast.success("Shop updated successfully")
    } catch (error) {
      console.error("Error updating shop:", error)
      toast.error("Failed to update shop")
    }
  }

  const handleAddPackage = async () => {
    if (!selectedPackage || !profitMargin) {
      toast.error("Please select package and enter selling price")
      return
    }

    try {
      // Get the base price from selected package
      const pkg = getPackageDetails(selectedPackage)
      const basePrice = pkg?.price || 0
      const sellingPrice = parseFloat(profitMargin || "0")
      const calculatedProfit = sellingPrice - basePrice
      
      if (calculatedProfit < 0) {
        toast.error("Selling price must be higher than base price")
        return
      }
      
      const addedPkg = await shopPackageService.addPackageToShop(
        shop.id,
        selectedPackage,
        calculatedProfit
      )
      
      const updatedPkgs = await shopPackageService.getShopPackages(shop.id)
      setPackages(updatedPkgs)
      
      // Clear only the form, stay on the adding page
      setSelectedPackage("")
      setProfitMargin("")
      toast.success("Package added to shop!")
    } catch (error: any) {
      console.error("Error adding package:", error)
      const errorMsg = error?.message || "Failed to add package"
      toast.error(errorMsg)
    }
  }

  const copyShopLink = () => {
    const link = `${window.location.origin}/shop/${shop.shop_slug}`
    navigator.clipboard.writeText(link)
    toast.success("Shop link copied to clipboard")
  }

  const getPackageDetails = (packageId: string) => {
    return allPackages.find(p => p.id === packageId)
  }

  const getShopPackageDetails = (shopPackage: any) => {
    const pkg = getPackageDetails(shopPackage.package_id)
    return pkg
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <p className="text-gray-500">Loading shop...</p>
        </div>
      </DashboardLayout>
    )
  }

  if (!shop) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">My Shop</h1>
            <p className="text-gray-500 mt-1">Create your store and start reselling data packages</p>
          </div>
          
          {dbError && (
            <Alert className="border-red-300 bg-red-50">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-700">
                {dbError}
                <div className="mt-2 text-xs">
                  Run the SQL schema from <code className="bg-red-100 px-1 rounded">lib/shop-schema.sql</code> in your Supabase SQL Editor to set up tables.
                </div>
              </AlertDescription>
            </Alert>
          )}
          
          <Card className="bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Store className="w-5 h-5 text-emerald-600" />
                Create Your Shop
              </CardTitle>
              <CardDescription>Get started selling data packages to your customers</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="shop-name">Shop Name *</Label>
                <Input
                  id="shop-name"
                  value={formData.shop_name}
                  onChange={(e) => setFormData({ ...formData, shop_name: e.target.value })}
                  placeholder="e.g., My Mobile Shop"
                  className="mt-1"
                />
              </div>
              
              <div>
                <Label htmlFor="shop-description">Description</Label>
                <Textarea
                  id="shop-description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Tell customers about your shop..."
                  className="mt-1"
                  rows={4}
                />
              </div>

              <div>
                <Label htmlFor="shop-logo">Shop Logo</Label>
                <div className="mt-1 flex items-center gap-3">
                  <Input
                    id="shop-logo"
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        const reader = new FileReader()
                        reader.onloadend = () => {
                          setFormData({ ...formData, logo_url: reader.result as string })
                        }
                        reader.readAsDataURL(file)
                      }
                    }}
                    className="mt-1"
                  />
                  {formData.logo_url && (
                    <img
                      src={formData.logo_url}
                      alt="Logo preview"
                      className="w-12 h-12 rounded-lg object-cover border border-gray-300"
                    />
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">Upload an image file (JPG, PNG, etc.)</p>
              </div>

              <Button
                onClick={async () => {
                  if (!formData.shop_name.trim()) {
                    toast.error("Shop name is required")
                    return
                  }
                  try {
                    if (!user?.id) {
                      toast.error("User not authenticated")
                      return
                    }
                    // Generate shop slug from shop name with random suffix to ensure uniqueness
                    const baseSlug = formData.shop_name
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-+|-+$/g, "")
                    
                    // Add random suffix to prevent collisions when multiple users use the same name
                    const randomSuffix = Math.random().toString(36).substring(2, 9)
                    const shopSlug = `${baseSlug}-${randomSuffix}`
                    
                    const newShop = await shopService.createShop(user.id, {
                      shop_name: formData.shop_name,
                      shop_slug: shopSlug,
                      description: formData.description,
                      logo_url: formData.logo_url,
                    })
                    setShop(newShop)
                    toast.success("Shop created successfully!")
                  } catch (error: any) {
                    console.error("Error creating shop:", error)
                    const errorMsg = error?.message || "Failed to create shop"
                    toast.error(errorMsg)
                  }
                }}
                disabled={loading}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 font-semibold"
              >
                {loading ? "Creating..." : "Create Shop"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">My Shop</h1>
          <p className="text-gray-500 mt-1">Manage your store and resell data packages</p>
        </div>

        {/* Shop Info Card */}
        <Card className="bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40 hover:border-violet-300/60">
          <CardHeader className="flex flex-row items-start justify-between">
            <div className="flex items-center gap-4">
              {shop.logo_url && (
                <img
                  src={shop.logo_url}
                  alt={shop.shop_name}
                  className="w-16 h-16 rounded-lg object-cover"
                />
              )}
              <div>
                <CardTitle className="text-2xl">{shop.shop_name}</CardTitle>
                <CardDescription className="mt-2">{shop.description || "No description"}</CardDescription>
              </div>
            </div>
            <Badge className="bg-gradient-to-r from-green-600 to-emerald-600">
              {shop.is_active ? "Active" : "Inactive"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 p-3 bg-white/40 rounded-lg border border-white/20">
              <code className="text-sm font-mono flex-1">{`${window.location.origin}/shop/${shop.shop_slug}`}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={copyShopLink}
                className="hover:bg-violet-100"
              >
                <Copy className="w-4 h-4" />
              </Button>
              <Link href={`/shop/${shop.shop_slug}`} target="_blank">
                <Button
                  size="sm"
                  variant="ghost"
                  className="hover:bg-violet-100"
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
              </Link>
            </div>

            <div className="grid grid-cols-3 gap-4 pt-4">
              <div className="p-3 bg-white/40 rounded-lg border border-white/20">
                <p className="text-xs text-gray-600">Total Products</p>
                <p className="text-2xl font-bold text-violet-600">{packages.length}</p>
              </div>
              <div className="p-3 bg-white/40 rounded-lg border border-white/20">
                <p className="text-xs text-gray-600">Shop Status</p>
                <p className="text-sm font-semibold text-green-600">Online</p>
              </div>
              <div className="p-3 bg-white/40 rounded-lg border border-white/20">
                <p className="text-xs text-gray-600">Slug</p>
                <p className="text-sm font-mono font-semibold">{shop.shop_slug}</p>
              </div>
            </div>

            {!editingShop ? (
              <Button
                onClick={() => setEditingShop(true)}
                className="bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 w-full"
              >
                Edit Shop
              </Button>
            ) : (
              <div className="space-y-4 pt-4 border-t border-white/20">
                <div>
                  <Label>Shop Name</Label>
                  <Input
                    value={formData.shop_name}
                    onChange={(e) => setFormData({ ...formData, shop_name: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Description</Label>
                  <Textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="mt-1"
                    rows={3}
                  />
                </div>
                <div>
                  <Label>Shop Logo</Label>
                  <div className="mt-1 flex items-center gap-3">
                    <Input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          const reader = new FileReader()
                          reader.onloadend = () => {
                            setFormData({ ...formData, logo_url: reader.result as string })
                          }
                          reader.readAsDataURL(file)
                        }
                      }}
                      className="mt-1"
                    />
                    {formData.logo_url && (
                      <img
                        src={formData.logo_url}
                        alt="Logo preview"
                        className="w-12 h-12 rounded-lg object-cover border border-gray-300"
                      />
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Upload an image file (JPG, PNG, etc.)</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handleUpdateShop}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                  >
                    Save Changes
                  </Button>
                  <Button
                    onClick={() => setEditingShop(false)}
                    variant="outline"
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tabs */}
        <Tabs defaultValue="products" className="space-y-4">
          <TabsList className="bg-white/40 backdrop-blur border border-white/20">
            <TabsTrigger value="products" className="data-[state=active]:bg-white/60">
              <Package className="w-4 h-4 mr-2" />
              Products
            </TabsTrigger>
            <TabsTrigger value="orders" className="data-[state=active]:bg-white/60">
              Store Overview
            </TabsTrigger>
          </TabsList>

          {/* Products Tab */}
          <TabsContent value="products">
            <Card className="bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Shop Products</CardTitle>
                  <CardDescription>Manage products available in your store</CardDescription>
                </div>
                {!addingPackage && (
                  <Button
                    onClick={() => setAddingPackage(true)}
                    className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Product
                  </Button>
                )}
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Add Packages Grid */}
                {addingPackage && (
                  <div className="mb-6">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-semibold">Available Packages</h3>
                      <Button
                        onClick={() => {
                          setAddingPackage(false)
                          setSelectedPackage("")
                          setProfitMargin("")
                          setSelectedNetwork("All")
                        }}
                        variant="outline"
                        size="sm"
                      >
                        Done
                      </Button>
                    </div>
                    
                    {/* Network Filter */}
                    <div className="mb-4 flex gap-2 flex-wrap">
                      <Button
                        onClick={() => setSelectedNetwork("All")}
                        variant={selectedNetwork === "All" ? "default" : "outline"}
                        size="sm"
                        className={selectedNetwork === "All" ? "bg-blue-600" : ""}
                      >
                        All Networks
                      </Button>
                      {[...new Set(allPackages.map(p => p.network))].sort().map(network => (
                        <Button
                          key={network}
                          onClick={() => setSelectedNetwork(network)}
                          variant={selectedNetwork === network ? "default" : "outline"}
                          size="sm"
                          className={selectedNetwork === network ? "bg-blue-600" : ""}
                        >
                          {network}
                        </Button>
                      ))}
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {(() => {
                        const filteredPackages = selectedNetwork === "All" 
                          ? allPackages 
                          : allPackages.filter(p => p.network === selectedNetwork)
                        
                        return filteredPackages
                          .sort((a, b) => parseFloat(a.size) - parseFloat(b.size))
                          .map((pkg) => (
                            <Card key={pkg.id} className="border border-emerald-200/40 bg-gradient-to-br from-emerald-50/60 to-teal-50/40">
                              <CardContent className="p-4 space-y-3">
                                <div>
                                  <p className="font-semibold text-emerald-900">{pkg.network} - {pkg.size}GB</p>
                                  <p className="text-sm text-gray-600">Base Price: GHS {pkg.price}</p>
                                </div>
                                
                                {(() => {
                                  const isAdded = packages.find(p => p.package_id === pkg.id)
                                  return (
                                    <>
                                      {isAdded && (
                                        <div className="bg-blue-50 p-2 rounded-md text-xs border border-blue-200">
                                          <p className="text-blue-700">
                                            <span className="font-semibold">Current Selling Price:</span> GHS {((isAdded.packages?.price || pkg.price) + isAdded.profit_margin).toFixed(2)}
                                          </p>
                                          <p className="text-blue-600">
                                            Your Profit: GHS {isAdded.profit_margin.toFixed(2)}
                                          </p>
                                        </div>
                                      )}
                                    </>
                                  )
                                })()}
                                
                                <div>
                                  <Label className="text-xs">Your Selling Price (GHS)</Label>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    placeholder="Enter price"
                                    value={selectedPackage === pkg.id ? profitMargin : ""}
                                    onChange={(e) => {
                                      setSelectedPackage(pkg.id)
                                      setProfitMargin(e.target.value)
                                    }}
                                    className="mt-1 text-sm"
                                  />
                                </div>
                                
                                {selectedPackage === pkg.id && profitMargin && (
                                  (() => {
                                    const profit = parseFloat(profitMargin) - pkg.price
                                    const isNegative = profit < 0
                                    return (
                                      <div className={`p-2 rounded-md text-xs space-y-1 ${
                                        isNegative
                                          ? "bg-red-50 border border-red-200"
                                          : "bg-emerald-50"
                                      }`}>
                                        <p className={isNegative ? "text-red-700" : "text-emerald-700"}>
                                          <span className="font-semibold">Your Profit:</span> GHS {profit.toFixed(2)}
                                        </p>
                                        {isNegative && (
                                          <p className="text-red-600 text-xs">
                                            ⚠️ Selling price must be higher than base price
                                          </p>
                                        )}
                                      </div>
                                    )
                                  })()
                                )}
                                
                                {(() => {
                                  const isAdded = packages.some(p => p.package_id === pkg.id)
                                  const profit = selectedPackage === pkg.id && profitMargin ? parseFloat(profitMargin) - pkg.price : 0
                                  const hasNegativeProfit = profit < 0
                                  return (
                                    <Button
                                      onClick={() => {
                                        if (selectedPackage === pkg.id && profitMargin) {
                                          handleAddPackage()
                                        }
                                      }}
                                      disabled={selectedPackage !== pkg.id || !profitMargin || hasNegativeProfit}
                                      size="sm"
                                      className={`w-full ${
                                        isAdded
                                          ? "bg-blue-600 hover:bg-blue-700"
                                          : "bg-emerald-600 hover:bg-emerald-700"
                                      } disabled:opacity-50`}
                                    >
                                      {isAdded ? "✓ Edit" : "Add to Shop"}
                                    </Button>
                                  )
                                })()}
                              </CardContent>
                            </Card>
                          ))
                      })()}
                    </div>
                  </div>
                )}

                {/* Products List */}
                {packages.length === 0 ? (
                  <div className="text-center py-8">
                    <Package className="w-12 h-12 mx-auto text-gray-400 mb-2" />
                    <p className="text-gray-600">No products yet. Add your first product!</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {packages.map((shopPkg) => {
                      const pkg = shopPkg.packages
                      const sellingPrice = (pkg?.price || 0) + shopPkg.profit_margin
                      return (
                        <div
                          key={shopPkg.id}
                          className="flex items-center justify-between p-4 bg-white/50 border border-emerald-200/40 rounded-lg hover:bg-white/70 transition-colors"
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <p className="font-semibold">{pkg?.network} - {pkg?.size}GB</p>
                              {shopPkg.is_available && (
                                <Badge className="bg-green-100 text-green-700">Available</Badge>
                              )}
                            </div>
                            <p className="text-sm text-gray-600">
                              Base: GHS {pkg?.price} | Your Price: GHS {sellingPrice.toFixed(2)}
                            </p>
                            <p className="text-xs text-emerald-600 font-semibold">
                              Your Profit: GHS {shopPkg.profit_margin.toFixed(2)}
                            </p>
                          </div>
                          <Button variant="outline" size="sm">
                            Manage
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Orders Tab */}
          <TabsContent value="orders">
            <Card className="bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40">
              <CardHeader>
                <CardTitle>Store Overview</CardTitle>
                <CardDescription>Coming soon: Order management and analytics</CardDescription>
              </CardHeader>
              <CardContent>
                <Alert className="border-blue-300 bg-blue-50">
                  <AlertCircle className="h-4 w-4 text-blue-600" />
                  <AlertDescription className="text-blue-700">
                    Order analytics and management will be available once your first customer makes a purchase.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
