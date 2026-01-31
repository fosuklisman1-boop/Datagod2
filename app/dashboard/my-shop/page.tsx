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
import { shopService, shopPackageService, shopOrderService } from "@/lib/shop-service"
import { packageService } from "@/lib/database"
import { supabase } from "@/lib/supabase"
import { AlertCircle, Check, Copy, ExternalLink, Store, Package, Plus, MessageCircle, Search } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"
import { ComplaintModal } from "@/components/complaint-modal"

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
  const [editingShopPackage, setEditingShopPackage] = useState<any>(null)
  const [packageAvailable, setPackageAvailable] = useState(true)
  const [dbError, setDbError] = useState<string | null>(null)
  const [selectedNetwork, setSelectedNetwork] = useState<string>("All")
  const [whatsappLink, setWhatsappLink] = useState("")
  const [savingWhatsapp, setSavingWhatsapp] = useState(false)
  const [shopOrders, setShopOrders] = useState<any[]>([])
  const [updatingShop, setUpdatingShop] = useState(false)
  const [togglingPackageId, setTogglingPackageId] = useState<string | null>(null)
  const [orderStats, setOrderStats] = useState({
    total: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    totalRevenue: 0,
  })
  const [searchPhoneNumber, setSearchPhoneNumber] = useState("")
  const [selectedComplaintOrder, setSelectedComplaintOrder] = useState<any>(null)
  const [showComplaintModal, setShowComplaintModal] = useState(false)
  const [userRole, setUserRole] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    loadShopData()
  }, [user])

  const loadShopData = async () => {
    try {
      setLoading(true)
      setDbError(null)
      if (!user?.id) return

      // Fetch user role
      const { data: roleData } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single()
      setUserRole(roleData?.role || null)

      const userShop = await shopService.getShop(user.id)
      setShop(userShop)

      if (userShop) {
        // Get auth token for API calls
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token

        // For sub-agents, load from sub_agent_catalog API
        // For regular shops, load from shop_packages
        if (userShop.parent_shop_id && token) {
          // Sub-agent: get own catalog from sub_agent_catalog
          try {
            const response = await fetch("/api/shop/sub-agent-catalog", {
              headers: { "Authorization": `Bearer ${token}` }
            })
            const data = await response.json()
            if (!response.ok) {
              console.error("Sub-agent catalog API error:", response.status, data.error)
              setPackages([])
            } else if (data.catalog) {
              // Transform to match expected format
              const catalogItems = data.catalog.map((item: any) => ({
                id: item.id,
                package_id: item.package_id,
                profit_margin: item.profit_margin || item.wholesale_margin,
                is_available: item.is_active,
                packages: item.package,
                wholesale_price: item.wholesale_price
              }))
              setPackages(catalogItems)
            } else {
              setPackages([])
            }
          } catch (catalogError: any) {
            console.error("Error loading sub-agent catalog:", catalogError)
            setPackages([])
          }
        } else {
          // Regular shop owner: load from shop_packages
          try {
            const shopPkgs = await shopPackageService.getShopPackages(userShop.id)
            setPackages(shopPkgs || [])
          } catch (pkgError: any) {
            console.error("Error loading packages:", pkgError)
            setPackages([])
          }
        }

        setFormData({
          shop_name: userShop.shop_name || "",
          description: userShop.description || "",
          logo_url: userShop.logo_url || "",
        })

        // Load WhatsApp settings
        try {
          const settingsResponse = await fetch(`/api/shop/settings/${userShop.id}`)
          if (settingsResponse.ok) {
            const settingsData = await settingsResponse.json()
            if (settingsData.whatsapp_link) {
              setWhatsappLink(settingsData.whatsapp_link)
            }
          } else {
            console.error("Settings API returned:", settingsResponse.status)
          }
        } catch (settingsError) {
          console.error("Error loading shop settings:", settingsError)
        }

        // For sub-agents (shops with parent_shop_id), get packages from parent shop
        // For regular shops, get all admin packages
        console.log("=== MY SHOP DEBUG ===")
        console.log("Shop ID:", userShop.id)
        console.log("Shop Name:", userShop.shop_name)
        console.log("Parent Shop ID:", userShop.parent_shop_id)
        console.log("Is Sub-agent:", !!userShop.parent_shop_id)

        if (userShop.parent_shop_id) {
          // Sub-agent: get parent shop's packages via API (bypasses RLS)
          console.log("=== LOADING PARENT PACKAGES VIA API ===")
          try {
            const { data: { session } } = await supabase.auth.getSession()
            const token = session?.access_token

            if (!token) {
              console.error("No access token available")
              setAllPackages([])
              return
            }

            const response = await fetch("/api/shop/parent-packages", {
              headers: {
                "Authorization": `Bearer ${token}`
              }
            })

            if (!response.ok) {
              console.error("Parent packages API error:", response.status, response.statusText)
              setAllPackages([])
              return
            }

            const data = await response.json()
            console.log("Parent packages API response:", data)

            if (data.packages && data.packages.length > 0) {
              setAllPackages(data.packages)
              console.log("Set allPackages to parent's packages:", data.packages.length)
            } else {
              console.log("No parent packages found, sub-agent has nothing to sell yet")
              setAllPackages([])
            }
          } catch (parentPkgError: any) {
            console.error("Error loading parent packages:", parentPkgError)
            setAllPackages([])
          }
        } else {
          // Regular shop owner: get all admin packages
          try {
            const allPkgs = await packageService.getPackages()
            setAllPackages(allPkgs || [])
          } catch (allPkgError: any) {
            console.error("Error loading all packages:", allPkgError)
            setAllPackages([])
          }
        }
      } else {
        // No shop yet, get all packages for reference
        try {
          const allPkgs = await packageService.getPackages()
          setAllPackages(allPkgs || [])
        } catch (allPkgError: any) {
          console.error("Error loading all packages:", allPkgError)
          setAllPackages([])
        }
      }

      // Load orders and calculate stats
      if (userShop) {
        try {
          const orders = await shopOrderService.getShopOrders(userShop.id)
          setShopOrders(orders || [])

          // Calculate stats
          const stats = {
            total: orders?.length || 0,
            completed: orders?.filter((o: any) => o.order_status === "completed").length || 0,
            pending: orders?.filter((o: any) => o.order_status === "pending").length || 0,
            failed: orders?.filter((o: any) => o.order_status === "failed").length || 0,
            totalRevenue: orders?.reduce((sum: number, o: any) => sum + (o.profit_amount || 0), 0) || 0,
          }
          setOrderStats(stats)
        } catch (ordersError: any) {
          console.error("Error loading orders:", ordersError)
          setShopOrders([])
        }
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

    setUpdatingShop(true)
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
      const errorMessage = error instanceof Error ? error.message : "Failed to update shop"
      toast.error(errorMessage)
    } finally {
      setUpdatingShop(false)
    }
  }

  const handleSaveWhatsappLink = async () => {
    if (!shop || !whatsappLink.trim()) {
      toast.error("Please enter a WhatsApp link")
      return
    }

    try {
      setSavingWhatsapp(true)

      // Get auth token from session
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      if (!token) {
        toast.error("Not authenticated")
        return
      }

      const response = await fetch(`/api/shop/settings/${shop.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          whatsapp_link: whatsappLink,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        toast.error(result.error || "Failed to save WhatsApp link")
        return
      }

      toast.success("WhatsApp link saved successfully!")
    } catch (error) {
      console.error("Error saving WhatsApp link:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to save WhatsApp link"
      toast.error(errorMessage)
    } finally {
      setSavingWhatsapp(false)
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
      // For sub-agents: calculate profit from PARENT PRICE (not admin price)
      // This is the sub-agent's own profit margin
      const parentPrice = pkg?.parent_price !== undefined ? pkg?.parent_price : (pkg?.price || 0)

      const sellingPrice = parseFloat(profitMargin || "0")
      let subAgentProfit: number
      // Always use parentPrice (which is correct for both sub-agents and regular shops)
      subAgentProfit = sellingPrice - parentPrice

      if (subAgentProfit < 0) {
        toast.error("Selling price must be higher than base price")
        return
      }

      // Get auth token
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      if (!token) {
        toast.error("Not authenticated")
        return
      }

      // Check if sub-agent
      if (shop.parent_shop_id) {
        // Sub-agent: use sub_agent_catalog API
        const pkg = getPackageDetails(selectedPackage)
        const realPackageId = pkg?.package_id || selectedPackage // Sub-agents need the package_id, not the catalog id

        const existingPkg = packages.find(p => p.package_id === realPackageId)

        if (existingPkg) {
          // Update existing catalog item
          const response = await fetch("/api/shop/sub-agent-catalog", {
            method: "PUT",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              catalog_id: existingPkg.id,
              sub_agent_profit_margin: subAgentProfit
            })
          })
          if (!response.ok) {
            const data = await response.json()
            throw new Error(data.error || "Failed to update package")
          }
          toast.success("Package updated successfully!")
        } else {
          // Add new catalog item
          const response = await fetch("/api/shop/sub-agent-catalog", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              package_id: realPackageId,
              sub_agent_profit_margin: subAgentProfit,
              parent_price: parentPrice
            })
          })
          if (!response.ok) {
            const data = await response.json()
            throw new Error(data.error || "Failed to add package")
          }
          toast.success("Package added to catalog!")
        }

        // Reload sub-agent catalog
        const catalogResponse = await fetch("/api/shop/sub-agent-catalog", {
          headers: { "Authorization": `Bearer ${token}` }
        })
        const catalogData = await catalogResponse.json()
        if (!catalogResponse.ok) {
          console.error("Failed to reload catalog after add:", catalogResponse.status, catalogData.error)
        } else if (catalogData.catalog) {
          const catalogItems = catalogData.catalog.map((item: any) => ({
            id: item.id,
            package_id: item.package_id,
            profit_margin: item.profit_margin || item.wholesale_margin,
            is_available: item.is_active,
            packages: item.package,
            wholesale_price: item.wholesale_price
          }))
          setPackages(catalogItems)
        }
      } else {
        // Regular shop owner: use shop_packages
        const existingPkg = packages.find(p => p.package_id === selectedPackage)

        if (existingPkg) {
          await shopPackageService.updatePackageProfitMargin(
            existingPkg.id,
            subAgentProfit
          )
          toast.success("Package updated successfully!")
        } else {
          await shopPackageService.addPackageToShop(
            shop.id,
            selectedPackage,
            subAgentProfit
          )
          toast.success("Package added to shop!")
        }

        const updatedPkgs = await shopPackageService.getShopPackages(shop.id)
        setPackages(updatedPkgs)
      }

      // Clear only the form, stay on the adding page
      setSelectedPackage("")
      setProfitMargin("")
    } catch (error: any) {
      console.error("Error adding/updating package:", error)
      const errorMsg = error?.message || "Failed to add/update package"
      toast.error(errorMsg)
    }
  }

  const copyShopLink = () => {
    const link = `${window.location.origin}/shop/${shop.shop_slug}`
    navigator.clipboard.writeText(link)
    toast.success("Shop link copied to clipboard")
  }

  const handleToggleAvailability = async (shopPackageId: string, currentStatus: boolean) => {
    setTogglingPackageId(shopPackageId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      if (shop.parent_shop_id && token) {
        // Sub-agent: toggle via sub_agent_catalog API
        const response = await fetch("/api/shop/sub-agent-catalog", {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            catalog_id: shopPackageId,
            is_active: !currentStatus
          })
        })
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || "Failed to toggle availability")
        }

        // Reload catalog
        const catalogResponse = await fetch("/api/shop/sub-agent-catalog", {
          headers: { "Authorization": `Bearer ${token}` }
        })
        const catalogData = await catalogResponse.json()
        if (catalogData.catalog) {
          const catalogItems = catalogData.catalog.map((item: any) => ({
            id: item.id,
            package_id: item.package_id,
            profit_margin: item.profit_margin || item.wholesale_margin,
            is_available: item.is_active,
            packages: item.package,
            wholesale_price: item.wholesale_price
          }))
          setPackages(catalogItems)
        }
      } else {
        // Regular shop owner
        await shopPackageService.togglePackageAvailability(shopPackageId, !currentStatus)
        const updatedPkgs = await shopPackageService.getShopPackages(shop.id)
        setPackages(updatedPkgs)
      }
      toast.success(`Package marked as ${!currentStatus ? "available" : "unavailable"}`)
    } catch (error: any) {
      console.error("Error toggling availability:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to update availability"
      toast.error(errorMessage)
    } finally {
      setTogglingPackageId(null)
    }
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
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">My Shop</h1>
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
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">My Shop</h1>
          <p className="text-sm sm:text-base text-gray-500 mt-1">Manage your store and resell data packages</p>
        </div>

        {/* Shop Info Card */}
        <Card className="bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40 hover:border-violet-300/60">
          <CardHeader className="flex flex-col sm:flex-row items-start justify-between gap-3">
            <div className="flex items-center gap-3 sm:gap-4">
              {shop.logo_url && (
                <img
                  src={shop.logo_url}
                  alt={shop.shop_name}
                  className="w-12 h-12 sm:w-16 sm:h-16 rounded-lg object-cover"
                />
              )}
              <div>
                <CardTitle className="text-xl sm:text-2xl">{shop.shop_name}</CardTitle>
                <CardDescription className="mt-1 sm:mt-2 text-sm">{shop.description || "No description"}</CardDescription>
              </div>
            </div>
            <Badge className="bg-gradient-to-r from-green-600 to-emerald-600">
              {shop.is_active ? "Active" : "Inactive"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 p-3 bg-white/40 rounded-lg border border-white/20">
              <code className="text-xs sm:text-sm font-mono flex-1 break-all">{`${window.location.origin}/shop/${shop.shop_slug}`}</code>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={copyShopLink}
                  className="hover:bg-violet-100 flex-1 sm:flex-none"
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
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4">
              <div className="p-3 bg-white/40 rounded-lg border border-white/20">
                <p className="text-xs text-gray-600">Total Products</p>
                <p className="text-2xl font-bold text-violet-600">{packages.length}</p>
              </div>
              <div className="p-3 bg-white/40 rounded-lg border border-white/20">
                <p className="text-xs text-gray-600">Shop Status</p>
                <Badge className={shop?.is_active ? "bg-green-600" : "bg-orange-600"}>
                  {shop?.is_active ? "Active" : "Pending Approval"}
                </Badge>
              </div>
              <div className="p-3 bg-white/40 rounded-lg border border-white/20">
                <p className="text-xs text-gray-600">Slug</p>
                <p className="text-sm font-mono font-semibold">{shop.shop_slug}</p>
              </div>
            </div>

            {!shop?.is_active && (
              <Alert className="border-orange-300 bg-orange-50">
                <AlertCircle className="h-4 w-4 text-orange-600" />
                <AlertDescription className="text-xs text-orange-700">
                  Your shop is pending admin approval. Once approved, you'll be able to accept customer orders and process payments.
                </AlertDescription>
              </Alert>
            )}

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
                  <Label htmlFor="shop-name-display">Shop Name</Label>
                  <div className="mt-1 p-3 bg-gray-100 rounded-md border border-gray-300">
                    <p className="font-semibold text-gray-900">{formData.shop_name}</p>
                    <p className="text-xs text-gray-500 mt-1">Shop name cannot be changed</p>
                  </div>
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
                    disabled={updatingShop}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                  >
                    {updatingShop ? (
                      <>
                        <span className="animate-spin mr-2">⏳</span>
                        Saving...
                      </>
                    ) : (
                      "Save Changes"
                    )}
                  </Button>
                  <Button
                    onClick={() => setEditingShop(false)}
                    variant="outline"
                    className="flex-1"
                    disabled={updatingShop}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* WhatsApp Configuration Card */}
        <Card className="bg-gradient-to-br from-green-50/60 to-emerald-50/40 backdrop-blur-xl border border-green-200/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-600" />
              WhatsApp Link
            </CardTitle>
            <CardDescription>Configure WhatsApp contact link for your customers</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="whatsapp-link" className="text-sm font-medium">
                WhatsApp Contact Link
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                This link will appear as a floating button on your storefront
              </p>
              <Input
                id="whatsapp-link"
                type="url"
                placeholder="https://wa.me/1234567890"
                value={whatsappLink}
                onChange={(e) => setWhatsappLink(e.target.value)}
                className="w-full"
              />
            </div>

            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
              <p className="font-semibold mb-2">How to get your WhatsApp link:</p>
              <ol className="list-decimal list-inside space-y-1 text-xs">
                <li>Open WhatsApp and go to your profile</li>
                <li>Go to Settings → Business tools → Business links</li>
                <li>Create a new link or copy existing one</li>
                <li>Or use: https://wa.me/YOUR_PHONE_NUMBER (with country code)</li>
              </ol>
            </div>

            {whatsappLink && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-700">
                  <span className="font-semibold">Preview:</span>{" "}
                  <a
                    href={whatsappLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green-600 hover:underline break-all"
                  >
                    {whatsappLink}
                  </a>
                </p>
              </div>
            )}

            <Button
              onClick={handleSaveWhatsappLink}
              disabled={savingWhatsapp || !whatsappLink.trim()}
              className="w-full bg-green-600 hover:bg-green-700"
            >
              {savingWhatsapp ? "Saving..." : "Save WhatsApp Link"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Packages Section */}
      <div className="space-y-6 mt-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-violet-600" />
              Manage Packages
            </CardTitle>
            <CardDescription>Add data packages to your shop</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                  <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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
                                      <p className="text-sm text-gray-600">
                                        {shop?.parent_shop_id ? "Your Cost (Parent Price):" : "Base Price:"} GHS {(pkg.parent_price ?? pkg.price ?? 0).toFixed(2)}
                                      </p>
                                    </div>

                                    {(() => {
                                      const isAdded = packages.find(p => p.package_id === (pkg.package_id || pkg.id))
                                      return (
                                        <>
                                          {isAdded && (
                                            <div className="bg-blue-50 p-2 rounded-md text-xs border border-blue-200">
                                              <p className="text-blue-700">
                                                <span className="font-semibold">Your Cost (Wholesale):</span> GHS {(pkg.parent_price ?? pkg.price ?? 0).toFixed(2)}
                                              </p>
                                              <p className="text-blue-700">
                                                <span className="font-semibold">Current Selling Price:</span> GHS {((pkg.parent_price ?? pkg.price ?? 0) + (isAdded.profit_margin || 0)).toFixed(2)}
                                              </p>
                                              <p className="text-blue-600">
                                                Your Profit: GHS {(isAdded.profit_margin || 0).toFixed(2)}
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
                                        const isDealer = userRole === 'dealer' || user?.user_metadata?.role === 'dealer'
                                        const dealerPrice = pkg.dealer_price && pkg.dealer_price > 0 ? pkg.dealer_price : undefined
                                        const basePrice = pkg.parent_price ?? (isDealer && dealerPrice ? dealerPrice : pkg.price) ?? 0
                                        const sellingPrice = parseFloat(profitMargin)
                                        const profit = sellingPrice - basePrice
                                        const isNegative = profit < 0
                                        return (
                                          <div className={`p-2 rounded-md text-xs space-y-1 ${isNegative
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
                                      const isAdded = packages.some(p => p.package_id === (pkg.package_id || pkg.id))
                                      const isDealer = userRole === 'dealer' || user?.user_metadata?.role === 'dealer'
                                      const dealerPrice = pkg.dealer_price && pkg.dealer_price > 0 ? pkg.dealer_price : undefined
                                      const basePrice = pkg.parent_price ?? (isDealer && dealerPrice ? dealerPrice : pkg.price) ?? 0
                                      const profit = selectedPackage === pkg.id && profitMargin ? parseFloat(profitMargin) - basePrice : 0
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
                                          className={`w-full ${isAdded
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
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {packages.map((shopPkg) => {
                          const pkg = shopPkg.packages
                          // Get the current parent price from available packages (source of truth)
                          const availablePkg = allPackages.find(p => p.id === pkg?.id)
                          const isDealer = userRole === 'dealer' || user?.user_metadata?.role === 'dealer'
                          const dealerPrice = pkg?.dealer_price && pkg.dealer_price > 0 ? pkg.dealer_price : undefined

                          // For dealers, prioritize dealer_price over stored parent_price
                          const currentParentPrice = (isDealer && dealerPrice)
                            ? dealerPrice
                            : (availablePkg?.parent_price !== undefined
                              ? availablePkg.parent_price
                              : (shopPkg.parent_price !== undefined
                                ? shopPkg.parent_price
                                : (pkg?.price || 0)))
                          const displayBasePrice = currentParentPrice
                          const sellingPrice = displayBasePrice + (shopPkg.profit_margin || 0)
                          const profit = shopPkg.profit_margin || 0
                          return (
                            <Card key={shopPkg.id} className="border border-emerald-200/40 bg-gradient-to-br from-emerald-50/60 to-teal-50/40">
                              <CardContent className="p-4 space-y-3">
                                <div>
                                  <p className="font-semibold text-emerald-900">{pkg?.network} - {pkg?.size}GB</p>
                                  <p className="text-sm text-gray-600">
                                    {shop?.parent_shop_id ? "Your Cost (Parent Price):" : "Base Price:"} GHS {displayBasePrice.toFixed(2)}
                                  </p>
                                </div>

                                <div className="bg-blue-50 p-2 rounded-md text-xs border border-blue-200">
                                  <p className="text-blue-700">
                                    <span className="font-semibold">Your Cost (Wholesale):</span> GHS {displayBasePrice.toFixed(2)}
                                  </p>
                                  <p className="text-blue-700">
                                    <span className="font-semibold">Current Selling Price:</span> GHS {sellingPrice.toFixed(2)}
                                  </p>
                                  <p className="text-blue-600">
                                    Your Profit: GHS {profit.toFixed(2)}
                                  </p>
                                </div>

                                <div className="flex items-center gap-2 pt-2">
                                  {shopPkg.is_available ? (
                                    <Badge className="bg-green-100 text-green-700">Available</Badge>
                                  ) : (
                                    <Badge className="bg-gray-100 text-gray-700">Unavailable</Badge>
                                  )}
                                  {availablePkg && !availablePkg.active && (
                                    <Badge className="bg-red-100 text-red-700 text-xs">Parent Disabled</Badge>
                                  )}
                                </div>

                                <div className="flex gap-2 pt-2">
                                  <Button
                                    onClick={() => {
                                      setEditingShopPackage(shopPkg)
                                      // Find matching package in allPackages to get the correct ID (catalog ID for sub-agents)
                                      const availablePkg = allPackages.find(p => (p.package_id || p.id) === shopPkg.package_id)
                                      setSelectedPackage(availablePkg ? availablePkg.id : shopPkg.package_id)
                                      setProfitMargin(sellingPrice.toFixed(2))
                                      setPackageAvailable(shopPkg.is_available)
                                      setAddingPackage(true)
                                    }}
                                    size="sm"
                                    className="flex-1 bg-blue-600 hover:bg-blue-700"
                                  >
                                    ✎ Edit
                                  </Button>
                                  <Button
                                    onClick={() => handleToggleAvailability(shopPkg.id, shopPkg.is_available)}
                                    disabled={togglingPackageId === shopPkg.id}
                                    variant="outline"
                                    size="sm"
                                    className="flex-1"
                                  >
                                    {togglingPackageId === shopPkg.id ? (
                                      <span className="animate-spin">⏳</span>
                                    ) : (
                                      shopPkg.is_available ? "Hide" : "Show"
                                    )}
                                  </Button>
                                </div>
                              </CardContent>
                            </Card>
                          )
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Orders Tab */}
              <TabsContent value="orders">
                <div className="space-y-6">
                  {/* Stats Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4">
                    <Card className="bg-gradient-to-br from-blue-50/60 to-cyan-50/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-gray-600">Total Orders</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-bold text-blue-600">{orderStats.total}</p>
                      </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-green-50/60 to-emerald-50/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-gray-600">Completed</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-bold text-green-600">{orderStats.completed}</p>
                      </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-yellow-50/60 to-orange-50/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-gray-600">Pending</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-bold text-orange-600">{orderStats.pending}</p>
                      </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-red-50/60 to-pink-50/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-gray-600">Failed</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-bold text-red-600">{orderStats.failed}</p>
                      </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-purple-50/60 to-violet-50/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-gray-600">Total Revenue</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-bold text-purple-600">GHS {orderStats.totalRevenue.toFixed(2)}</p>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Orders Table */}
                  <Card className="bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40">
                    <CardHeader>
                      <CardTitle>Recent Orders</CardTitle>
                      <CardDescription>
                        {shopOrders.length === 0
                          ? "No orders yet. Your first customer purchase will appear here."
                          : `Showing ${shopOrders.length} order${shopOrders.length !== 1 ? 's' : ''}`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {shopOrders.length > 0 && (
                        <div className="flex gap-2">
                          <Search className="w-5 h-5 text-gray-400 mt-2.5" />
                          <Input
                            type="text"
                            placeholder="Search orders by customer phone number..."
                            value={searchPhoneNumber}
                            onChange={(e) => setSearchPhoneNumber(e.target.value)}
                            className="bg-white/50 border-cyan-200/40"
                          />
                        </div>
                      )}
                      {shopOrders.length === 0 ? (
                        <Alert className="border-blue-300 bg-blue-50">
                          <AlertCircle className="h-4 w-4 text-blue-600" />
                          <AlertDescription className="text-blue-700">
                            Order analytics and management will show here once your first customer makes a purchase.
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="border-b border-cyan-200/40">
                              <tr>
                                <th className="text-left py-3 px-4 font-semibold text-gray-700">Order ID</th>
                                <th className="text-left py-3 px-4 font-semibold text-gray-700">Customer</th>
                                <th className="text-left py-3 px-4 font-semibold text-gray-700">Network</th>
                                <th className="text-left py-3 px-4 font-semibold text-gray-700">Volume</th>
                                <th className="text-left py-3 px-4 font-semibold text-gray-700">Status</th>
                                <th className="text-right py-3 px-4 font-semibold text-gray-700">Profit</th>
                                <th className="text-left py-3 px-4 font-semibold text-gray-700">Date</th>
                                <th className="text-left py-3 px-4 font-semibold text-gray-700">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-cyan-100/40">
                              {shopOrders
                                .filter((order) =>
                                  order.customer_phone &&
                                  order.customer_phone.toLowerCase().includes(searchPhoneNumber.toLowerCase())
                                )
                                .map((order: any) => (
                                  <tr key={order.id} className="hover:bg-cyan-100/30 transition-colors">
                                    <td className="py-3 px-4 font-mono text-xs text-gray-600">{order.reference_code}</td>
                                    <td className="py-3 px-4">
                                      <div>
                                        <p className="font-medium text-gray-900">{order.customer_name || "N/A"}</p>
                                        <p className="text-xs text-gray-500">{order.customer_phone}</p>
                                      </div>
                                    </td>
                                    <td className="py-3 px-4">
                                      <Badge variant="outline">{order.network}</Badge>
                                    </td>
                                    <td className="py-3 px-4 text-gray-900">{order.volume_gb} GB</td>
                                    <td className="py-3 px-4">
                                      <Badge className={
                                        order.order_status === "completed" ? "bg-green-600" :
                                          order.order_status === "pending" ? "bg-orange-600" :
                                            "bg-red-600"
                                      }>
                                        {order.order_status}
                                      </Badge>
                                    </td>
                                    <td className="py-3 px-4 text-right font-semibold text-purple-600">
                                      GHS {(order.profit_amount || 0).toFixed(2)}
                                    </td>
                                    <td className="py-3 px-4 text-xs text-gray-500">
                                      <div>{new Date(order.created_at).toLocaleDateString()}</div>
                                      <div className="text-xs text-gray-500">{new Date(order.created_at).toLocaleTimeString()}</div>
                                    </td>
                                    <td className="py-3 px-4">
                                      <Button
                                        onClick={() => {
                                          setSelectedComplaintOrder({
                                            id: order.id,
                                            networkName: order.network || "Unknown",
                                            packageName: `${order.volume_gb || 0}GB`,
                                            phoneNumber: order.customer_phone || "N/A",
                                            totalPrice: parseFloat(order.total_price?.toString() || "0") || 0,
                                            createdAt: order.created_at || new Date().toISOString(),
                                          })
                                          setShowComplaintModal(true)
                                        }}
                                        variant="outline"
                                        size="sm"
                                        className="text-orange-600 border-orange-600 hover:bg-orange-50"
                                      >
                                        <MessageCircle className="w-4 h-4 mr-1" />
                                        Complain
                                      </Button>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      {/* Complaint Modal */}
      {selectedComplaintOrder && (
        <ComplaintModal
          isOpen={showComplaintModal}
          onClose={() => {
            setShowComplaintModal(false)
            setSelectedComplaintOrder(null)
          }}
          orderId={selectedComplaintOrder.id}
          orderType="shop"
          orderDetails={selectedComplaintOrder}
        />
      )}
    </DashboardLayout>
  )
}
