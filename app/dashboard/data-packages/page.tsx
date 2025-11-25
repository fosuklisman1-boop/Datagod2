"use client"

import { useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Grid3x3, List, Search } from "lucide-react"

// Sample data packages
const packages = [
  { id: 1, network: "AT - iShare", size: "1GB", price: 4.0, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 2, network: "AT - iShare", size: "2GB", price: 7.5, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 3, network: "AT - iShare", size: "5GB", price: 15.0, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 4, network: "TELECEL", size: "5GB", price: 19.0, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 5, network: "TELECEL", size: "10GB", price: 35.0, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 6, network: "TELECEL", size: "20GB", price: 65.0, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 7, network: "MTN", size: "1GB", price: 4.5, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 8, network: "MTN", size: "2GB", price: 8.5, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 9, network: "MTN", size: "5GB", price: 19.5, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 10, network: "AT - BigTime", size: "3GB", price: 12.0, features: ["No expiry", "Instant delivery", "24/7 support"] },
  { id: 11, network: "AT - BigTime", size: "10GB", price: 38.5, features: ["No expiry", "Instant delivery", "24/7 support"] },
]

export default function DataPackagesPage() {
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [selectedNetwork, setSelectedNetwork] = useState("All")
  const [searchTerm, setSearchTerm] = useState("")

  // Filter packages
  const filteredPackages = packages.filter((pkg) => {
    const networkMatch = selectedNetwork === "All" || pkg.network === selectedNetwork
    const searchMatch = pkg.size.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pkg.network.toLowerCase().includes(searchTerm.toLowerCase())
    return networkMatch && searchMatch
  })

  const networks = ["All", "AT - iShare", "TELECEL", "MTN", "AT - BigTime"]

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Data Packages</h1>
          <p className="text-gray-600 mt-1">Browse and purchase data packages from multiple networks</p>
        </div>

        {/* Search and Filters */}
        <Card>
          <CardHeader>
            <CardTitle>Search & Filter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search packages..."
                className="pl-10"
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
                  className={selectedNetwork === network ? "bg-blue-600" : ""}
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
                className={viewMode === "grid" ? "bg-blue-600" : ""}
              >
                <Grid3x3 className="w-4 h-4 mr-2" />
                Grid
              </Button>
              <Button
                variant={viewMode === "list" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("list")}
                className={viewMode === "list" ? "bg-blue-600" : ""}
              >
                <List className="w-4 h-4 mr-2" />
                List
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Packages Display */}
        {viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredPackages.map((pkg) => (
              <Card key={pkg.id} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex justify-between items-start">
                    <div>
                      <Badge className="mb-2">{pkg.network}</Badge>
                      <CardTitle className="text-2xl">{pkg.size}</CardTitle>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-blue-600">GHS {pkg.price.toFixed(2)}</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    {pkg.features.map((feature, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-sm text-gray-600">
                        <div className="w-1.5 h-1.5 bg-green-600 rounded-full"></div>
                        {feature}
                      </div>
                    ))}
                  </div>
                  <Button className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700">
                    Buy Now
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Network</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Size</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Price</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Features</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredPackages.map((pkg) => (
                      <tr key={pkg.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 text-sm">{pkg.network}</td>
                        <td className="px-6 py-4 text-sm font-semibold">{pkg.size}</td>
                        <td className="px-6 py-4 text-sm font-bold text-blue-600">GHS {pkg.price.toFixed(2)}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{pkg.features.join(", ")}</td>
                        <td className="px-6 py-4 text-sm">
                          <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                            Buy
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
      </div>
    </DashboardLayout>
  )
}
