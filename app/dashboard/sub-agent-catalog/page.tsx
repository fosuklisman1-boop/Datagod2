"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { supabase } from "@/lib/supabase"
import { shopService } from "@/lib/shop-service"
import { AlertCircle, Plus, Trash2, Package, Users, DollarSign } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"

interface CatalogItem {
  id: string
  package_id: string
  wholesale_margin: number
  is_active: boolean
  wholesale_price: number
  package: {
    id: string
    network: string
    size: string
    price: number
    dealer_price?: number
    description?: string
  }
}

export default function SubAgentCatalogPage() {
  const { user } = useAuth()
  const router = useRouter()
  const [shop, setShop] = useState<any>(null)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [hasSubAgents, setHasSubAgents] = useState(false)

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

      // Check if shop has sub-agents
      const { data: subAgents } = await supabase
        .from("user_shops")
        .select("id")
        .eq("parent_shop_id", userShop.id)
        .limit(1)

      setHasSubAgents((subAgents?.length || 0) > 0)

      // Get catalog
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      if (token) {
        const response = await fetch("/api/shop/sub-agent-catalog", {
          headers: { "Authorization": `Bearer ${token}` }
        })
        const data = await response.json()
        if (data.catalog) {
          // Normalize the data to ensure correct prices are used
          const isDealer = data.is_dealer || false
          setCatalog(data.catalog.map((item: any) => ({
            ...item,
            // Ensure the package price is shown correctly based on role
            package: {
              ...item.package,
              price: isDealer && item.package.dealer_price > 0 ? item.package.dealer_price : item.package.price
            }
          })))
        }
      }

    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveFromCatalog = async (catalogId: string) => {
    if (!confirm("Remove this package from sub-agent catalog?")) return

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      if (!token) {
        toast.error("Not authenticated")
        return
      }

      const response = await fetch(`/api/shop/sub-agent-catalog?id=${catalogId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      })

      if (!response.ok) {
        throw new Error("Failed to remove from catalog")
      }

      toast.success("Package removed from catalog")
      loadData()

    } catch (error: any) {
      console.error("Error removing from catalog:", error)
      toast.error(error.message || "Failed to remove from catalog")
    }
  }

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
            You need to create a shop first before managing your sub-agent catalog.
          </AlertDescription>
        </Alert>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 px-2 sm:px-4">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-center">
          <div>
            <h1 className="text-2xl font-bold">Sub-Agent Catalog</h1>
            <p className="text-gray-500">
              Manage packages available for your sub-agents to sell
            </p>
          </div>

          <Link href="/dashboard/sub-agent-catalog/add">
            <Button className="bg-violet-600 hover:bg-violet-700">
              <Plus className="h-4 w-4 mr-2" />
              Add Packages
            </Button>
          </Link>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 sm:gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-violet-100 rounded-lg">
                  <Package className="h-6 w-6 text-violet-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Catalog Packages</p>
                  <p className="text-2xl font-bold">{catalog.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-green-100 rounded-lg">
                  <Users className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Has Sub-Agents</p>
                  <p className="text-2xl font-bold">{hasSubAgents ? "Yes" : "No"}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-blue-100 rounded-lg">
                  <DollarSign className="h-6 w-6 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Avg Margin</p>
                  <p className="text-2xl font-bold">
                    GHS {catalog.length > 0
                      ? (catalog.reduce((sum, c) => sum + (c.wholesale_margin || 0), 0) / catalog.length).toFixed(2)
                      : "0.00"
                    }
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Info Alert */}
        {!hasSubAgents && (
          <Alert className="bg-blue-50 border-blue-200">
            <AlertCircle className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-800">
              You don't have any sub-agents yet. Go to the <strong>Sub-Agents</strong> page to invite them.
              Once you add packages here, your sub-agents will be able to purchase and resell them.
            </AlertDescription>
          </Alert>
        )}

        {/* Catalog Table */}
        <Card>
          <CardHeader>
            <CardTitle>Your Sub-Agent Catalog</CardTitle>
            <CardDescription>
              These packages are available for your sub-agents to purchase at wholesale prices
            </CardDescription>
          </CardHeader>
          <CardContent>
            {catalog.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No packages in your sub-agent catalog yet.</p>
                <p className="text-sm mb-4">Click "Add Packages" to get started.</p>
                <Link href="/dashboard/sub-agent-catalog/add">
                  <Button className="bg-violet-600 hover:bg-violet-700">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Packages
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-gray-100">
                <Table className="min-w-[600px] w-full text-xs sm:text-sm">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Network</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead className="text-right">Admin Price</TableHead>
                      <TableHead className="text-right">Your Margin</TableHead>
                      <TableHead className="text-right">Wholesale Price</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {catalog.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">{item.package.network}</TableCell>
                        <TableCell>{item.package.size}</TableCell>
                        <TableCell className="text-right">GHS {(item.package?.price || 0).toFixed(2)}</TableCell>
                        <TableCell className="text-right text-green-600">
                          +GHS {(item.wholesale_margin || 0).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-bold">
                          GHS {(item.wholesale_price || 0).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleRemoveFromCatalog(item.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
