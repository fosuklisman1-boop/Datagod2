"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Grid3x3, List, Search, Loader2 } from "lucide-react"
import { PhoneNumberModal } from "@/components/phone-number-modal"
import { networkLogoService } from "@/lib/shop-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface Package {
  id: string
  network: string
  size: string
  price: number
  description?: string
}

export default function DataPackagesPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [selectedNetwork, setSelectedNetwork] = useState("All")
  const [searchTerm, setSearchTerm] = useState("")
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})
  const [packages, setPackages] = useState<Package[]>([])
  const [networks, setNetworks] = useState<string[]>(["All"])
  const [loading, setLoading] = useState(true)
  const [purchasing, setPurchasing] = useState<string | null>(null)
  const [wallet, setWallet] = useState<{ balance: number } | null>(null)
  const [phoneModalOpen, setPhoneModalOpen] = useState(false)
  const [selectedPackageForPurchase, setSelectedPackageForPurchase] = useState<Package | null>(null)

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[DATA-PACKAGES] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      loadPackages()
      loadWallet()
    }
  }, [user])

  useEffect(() => {
    loadNetworkLogos()
    loadPackages()
  }, [])

  const loadWallet = async () => {
    if (!user?.id) return

    try {
      const { data, error } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", user.id)
        .single()

      if (error && error.code === "PGRST116") {
        // No wallet found, create one via API
        console.log("[DATA-PACKAGES] Wallet not found, creating new wallet via API")
        const session = await supabase.auth.getSession()
        if (!session.data.session?.access_token) {
          console.error("[DATA-PACKAGES] No auth token available")
          setWallet({ balance: 0 })
          return
        }

        const response = await fetch("/api/wallet/create", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${session.data.session.access_token}`,
            "Content-Type": "application/json",
          },
        })

        if (!response.ok) {
          const errorData = await response.json()
          console.error("[DATA-PACKAGES] Error creating wallet:", errorData)
          setWallet({ balance: 0 })
          return
        }

        const result = await response.json()
        console.log("[DATA-PACKAGES] Wallet created:", result.wallet)
        setWallet({ balance: result.wallet.balance })
      } else if (error) {
        console.error("[DATA-PACKAGES] Error loading wallet:", error)
        setWallet({ balance: 0 })
        return
      }

      console.log("[DATA-PACKAGES] Wallet loaded:", data)
      setWallet(data)
    } catch (error) {
      console.error("[DATA-PACKAGES] Error loading wallet:", error)
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
      const { data, error } = await supabase
        .from("packages")
        .select("*")
        .eq("is_available", true)
        .order("network, size")

      if (error) {
        console.error("Error loading packages:", error)
        return
      }

      setPackages(data || [])

      // Extract unique networks
      const uniqueNetworks = ["All", ...Array.from(new Set(data?.map((pkg: Package) => pkg.network) || []))]
      setNetworks(uniqueNetworks as string[])
    } catch (error) {
      console.error("Error loading packages:", error)
    } finally {
      setLoading(false)
    }
  }

  const getNetworkLogo = (network: string): string => {
    // Try exact match first
    if (networkLogos[network]) {
      return networkLogos[network]
    }
    
    // Try normalized version (capitalize first letter)
    const normalized = network.charAt(0).toUpperCase() + network.slice(1).toLowerCase()
    if (networkLogos[normalized]) {
      return networkLogos[normalized]
    }

    // Return empty string if not found
    return ""
  }

  // Helper function to extract numeric value from size string for sorting
  const extractSizeValue = (size: string): number => {
    // Remove any whitespace and convert to uppercase for consistency
    const normalized = size.trim().toUpperCase()
    
    // Extract the numeric part (handles any number of digits)
    const match = normalized.match(/^(\d+)(?:\D|$)/)
    if (!match) return 0

    const value = parseInt(match[1], 10)
    
    // Return raw numeric value
    return value
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

    if (wallet.balance < pkg.price) {
      toast.error(`Insufficient balance. You need GHS ${pkg.price.toFixed(2)} but have GHS ${wallet.balance.toFixed(2)}`)
      return
    }

    // Show phone number modal instead of purchasing directly
    setSelectedPackageForPurchase(pkg)
    setPhoneModalOpen(true)
  }

  const handlePhoneNumberSubmit = async (phoneNumber: string) => {
    if (!selectedPackageForPurchase || !user) {
      toast.error("Error: Missing package or user information")
      return
    }

    try {
      setPurchasing(selectedPackageForPurchase.id)
      setPhoneModalOpen(false)

      // Get auth token
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Session expired, please login again")
        return
      }

      const response = await fetch("/api/orders/purchase", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          packageId: selectedPackageForPurchase.id,
          network: selectedPackageForPurchase.network,
          size: selectedPackageForPurchase.size,
          price: selectedPackageForPurchase.price,
          phoneNumber,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        toast.error(data.error || "Purchase failed")
        return
      }

      // Update wallet balance
      setWallet({ balance: data.newBalance })

      toast.success(`Successfully purchased ${selectedPackageForPurchase.network} ${selectedPackageForPurchase.size}!`)

      // Optionally redirect to orders page
      setTimeout(() => {
        router.push("/dashboard/my-orders")
      }, 1500)
    } catch (error) {
      console.error("Purchase error:", error)
      toast.error("An error occurred during purchase")
    } finally {
      setPurchasing(null)
      setSelectedPackageForPurchase(null)
    }
  }

  // Filter packages
  const filteredPackages = packages.filter((pkg) => {
    const networkMatch = selectedNetwork === "All" || pkg.network === selectedNetwork
    const searchMatch = pkg.size.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pkg.network.toLowerCase().includes(searchTerm.toLowerCase())
    return networkMatch && searchMatch
  }).sort((a, b) => {
    // Network priority order when "All" is selected
    const networkOrder = ["MTN", "Telecel", "AT-iShare", "AT-BigTime"]
    
    // Get network indices (use 999 for unknown networks to sort them last)
    const aNetworkIndex = networkOrder.indexOf(a.network) >= 0 ? networkOrder.indexOf(a.network) : 999
    const bNetworkIndex = networkOrder.indexOf(b.network) >= 0 ? networkOrder.indexOf(b.network) : 999
    
    // If networks are different, sort by network priority
    if (aNetworkIndex !== bNetworkIndex) {
      return aNetworkIndex - bNetworkIndex
    }
    
    // If same network, sort by data size (ascending) - convert to MB for proper numeric comparison
    const aSizeInMB = extractSizeValue(a.size)
    const bSizeInMB = extractSizeValue(b.size)
    return aSizeInMB - bSizeInMB
  })

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-cyan-600 via-blue-600 to-violet-600 bg-clip-text text-transparent">Data Packages</h1>
            <p className="text-gray-500 mt-1 font-medium">Browse and purchase data packages from multiple networks</p>
          </div>
          {wallet && (
            <Card className="bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
              <CardContent className="pt-6">
                <p className="text-sm text-gray-600">Wallet Balance</p>
                <p className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">
                  GHS {wallet.balance.toFixed(2)}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Search and Filters */}
        <Card className="hover:shadow-2xl transition-all duration-300 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60">
          <CardHeader>
            <CardTitle>Search & Filter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search packages..."
                className="pl-10 focus:ring-2 focus:ring-cyan-500 transition-all bg-white/70 backdrop-blur border-cyan-300/50 focus:border-cyan-400"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Network Filter */}
            <div className="flex flex-wrap gap-2">
              {networks.map((network) => (
                <Button
                  key={network}
                  variant={selectedNetwork === network ? "default" : "outline"}
                  onClick={() => setSelectedNetwork(network)}
                  className={`transition-all duration-200 ${selectedNetwork === network ? "bg-gradient-to-r from-cyan-600 to-blue-600 shadow-lg text-white" : "hover:border-cyan-400 hover:text-cyan-700 hover:bg-cyan-50/60 bg-cyan-50/30 backdrop-blur border-cyan-300/40 text-gray-700"}`}
                >
                  {network}
                </Button>
              ))}
            </div>

            {/* View Mode Toggle */}
            <div className="flex gap-2">
              <Button
                variant={viewMode === "grid" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("grid")}
                className={`transition-all duration-200 ${viewMode === "grid" ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white" : "hover:bg-cyan-50/80 backdrop-blur bg-cyan-50/30 border-cyan-300/40 text-gray-700 hover:text-cyan-700 hover:border-cyan-400"}`}
              >
                <Grid3x3 className="w-4 h-4 mr-2" />
                Grid
              </Button>
              <Button
                variant={viewMode === "list" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("list")}
                className={`transition-all duration-200 ${viewMode === "list" ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white" : "hover:bg-cyan-50/80 backdrop-blur bg-cyan-50/30 border-cyan-300/40 text-gray-700 hover:text-cyan-700 hover:border-cyan-400"}`}
              >
                <List className="w-4 h-4 mr-2" />
                List
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Packages Display */}
        {viewMode === "grid" ? (
          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredPackages.map((pkg) => (
              <Card key={pkg.id} className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-2 cursor-pointer group border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60 overflow-hidden flex flex-col">
                {/* Logo Section */}
                <div className="h-32 w-full bg-gray-100 flex items-center justify-center overflow-hidden">
                  {getNetworkLogo(pkg.network) && (
                    <img 
                      src={getNetworkLogo(pkg.network)} 
                      alt={pkg.network}
                      className="h-24 w-24 object-contain"
                    />
                  )}
                </div>
                
                <CardHeader>
                  <div className="flex justify-between items-start">
                    <div>
                      <Badge className="mb-2 bg-gradient-to-r from-cyan-400/40 to-blue-400/30 backdrop-blur text-cyan-700 group-hover:bg-gradient-to-r group-hover:from-cyan-600 group-hover:to-blue-600 group-hover:text-white transition-all border border-cyan-300/60">{pkg.network}</Badge>
                      <CardTitle className="text-2xl group-hover:text-cyan-600 transition-colors">{pkg.size.toString().replace(/[^0-9]/g, "")}GB</CardTitle>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent group-hover:from-violet-600 group-hover:to-fuchsia-600 transition-colors">GHS {pkg.price.toFixed(2)}</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 flex-1 flex flex-col justify-between">
                  {pkg.description && (
                    <p className="text-sm text-gray-600 group-hover:text-gray-900 transition-colors">
                      {pkg.description}
                    </p>
                  )}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-green-600 group-hover:text-green-700 transition-colors">
                      <div className="w-1.5 h-1.5 bg-green-600 rounded-full"></div>
                      No expiry
                    </div>
                    <div className="flex items-center gap-2 text-sm text-green-600 group-hover:text-green-700 transition-colors">
                      <div className="w-1.5 h-1.5 bg-green-600 rounded-full"></div>
                      Instant delivery
                    </div>
                  </div>
                  <Button 
                    onClick={() => handlePurchase(pkg)}
                    disabled={purchasing === pkg.id || !wallet || wallet.balance < pkg.price}
                    className="w-full bg-gradient-to-r from-cyan-600 via-blue-600 to-violet-600 hover:from-cyan-700 hover:via-blue-700 hover:to-violet-700 shadow-lg hover:shadow-xl transition-all duration-300 font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {purchasing === pkg.id ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Processing...
                      </>
                    ) : !wallet || wallet.balance < pkg.price ? (
                      "Insufficient Balance"
                    ) : (
                      "Buy Now"
                    )}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="hover:shadow-2xl transition-all duration-300 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gradient-to-r from-cyan-100/60 via-blue-100/60 to-violet-100/60 backdrop-blur border-b border-cyan-200/40">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Logo</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Network</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Size</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Price</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Description</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cyan-100/40">
                    {filteredPackages.map((pkg) => (
                      <tr key={pkg.id} className="hover:bg-cyan-100/30 hover:backdrop-blur transition-colors duration-200 cursor-pointer">
                        <td className="px-6 py-4 text-sm">
                          {getNetworkLogo(pkg.network) && (
                            <img 
                              src={getNetworkLogo(pkg.network)} 
                              alt={pkg.network}
                              className="h-8 w-8 object-contain"
                            />
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm font-medium text-gray-900">{pkg.network}</td>
                        <td className="px-6 py-4 text-sm font-semibold text-gray-900">{pkg.size.toString().replace(/[^0-9]/g, "")}GB</td>
                        <td className="px-6 py-4 text-sm font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">GHS {pkg.price.toFixed(2)}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{pkg.description || "-"}</td>
                        <td className="px-6 py-4 text-sm">
                          <Button 
                            size="sm" 
                            onClick={() => handlePurchase(pkg)}
                            disabled={purchasing === pkg.id || !wallet || wallet.balance < pkg.price}
                            className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 shadow-md hover:shadow-lg transition-all font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {purchasing === pkg.id ? (
                              <>
                                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                Processing...
                              </>
                            ) : !wallet || wallet.balance < pkg.price ? (
                              "No Balance"
                            ) : (
                              "Buy"
                            )}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results Count */}
        <p className="text-sm text-gray-600">
          Showing {filteredPackages.length} of {packages.length} packages
        </p>

        {/* Phone Number Modal */}
        <PhoneNumberModal
          open={phoneModalOpen}
          onOpenChange={setPhoneModalOpen}
          onSubmit={handlePhoneNumberSubmit}
          isLoading={purchasing !== null}
          packageName={selectedPackageForPurchase ? `${selectedPackageForPurchase.network} ${selectedPackageForPurchase.size}` : "Data Package"}
        />
      </div>
    </DashboardLayout>
  )
}
