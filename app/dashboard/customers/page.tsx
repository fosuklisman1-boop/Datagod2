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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertCircle, Search, Users, Loader2, TrendingUp, DollarSign, ShoppingCart, ChevronLeft } from "lucide-react"
import { toast } from "sonner"

interface Customer {
  id: string
  phone_number: string
  email: string
  customer_name: string
  first_purchase_at: string
  last_purchase_at: string
  total_purchases: number
  total_spent: number
  repeat_customer: boolean
  first_source_slug?: string
  preferred_network?: string
}

interface Order {
  id: string
  reference_code: string
  network: string
  volume_gb: number
  total_price: number
  order_status: string
  payment_status: string
  created_at: string
}

export default function CustomersPage() {
  const { user } = useAuth()
  const router = useRouter()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [customerHistory, setCustomerHistory] = useState<Order[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [filterRepeat, setFilterRepeat] = useState(false)
  const [sortBy, setSortBy] = useState<"last_purchase" | "total_spent" | "purchases">("last_purchase")
  const [pagination, setPagination] = useState({ limit: 50, offset: 0 })
  const [totalCount, setTotalCount] = useState(0)

  useEffect(() => {
    if (user?.id) {
      loadCustomers()
    }
  }, [user, filterRepeat, sortBy, pagination.offset])

  const loadCustomers = async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams({
        limit: pagination.limit.toString(),
        offset: pagination.offset.toString(),
      })

      const response = await fetch(`/api/admin/customers/list?${params}`, {
        headers: {
          Authorization: `Bearer ${user?.id}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to load customers")
      }

      const data = await response.json()
      let filteredCustomers = data.customers || []

      // Filter by repeat customer if toggled
      if (filterRepeat) {
        filteredCustomers = filteredCustomers.filter((c: Customer) => c.repeat_customer)
      }

      // Sort
      filteredCustomers.sort((a: Customer, b: Customer) => {
        switch (sortBy) {
          case "total_spent":
            return b.total_spent - a.total_spent
          case "purchases":
            return b.total_purchases - a.total_purchases
          case "last_purchase":
          default:
            return new Date(b.last_purchase_at).getTime() - new Date(a.last_purchase_at).getTime()
        }
      })

      setCustomers(filteredCustomers)
      setTotalCount(data.total || 0)
    } catch (error) {
      console.error("Error loading customers:", error)
      toast.error("Failed to load customers")
    } finally {
      setLoading(false)
    }
  }

  const loadCustomerHistory = async (customerId: string) => {
    try {
      setHistoryLoading(true)
      const response = await fetch(`/api/admin/customers/${customerId}/history`, {
        headers: {
          Authorization: `Bearer ${user?.id}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to load history")
      }

      const data = await response.json()
      setCustomerHistory(data.orders || [])
    } catch (error) {
      console.error("Error loading history:", error)
      toast.error("Failed to load customer history")
    } finally {
      setHistoryLoading(false)
    }
  }

  const handleCustomerClick = (customer: Customer) => {
    setSelectedCustomer(customer)
    loadCustomerHistory(customer.id)
  }

  const filteredCustomers = customers.filter(
    (c) =>
      c.customer_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.phone_number.includes(searchTerm) ||
      c.email.toLowerCase().includes(searchTerm.toLowerCase())
  )

  if (loading && customers.length === 0) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 pt-4">
        {/* Header with Back Button */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.back()}
            className="hover:bg-indigo-100"
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
              Customers
            </h1>
            <p className="text-gray-500 mt-1">Manage and analyze your customer base</p>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 lg:gap-4">
          {/* Total Customers */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-blue-500 bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Customers</CardTitle>
              <Users className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">
                {totalCount}
              </div>
              <p className="text-xs text-gray-500">Unique customers</p>
            </CardContent>
          </Card>

          {/* Repeat Customers */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-purple-500 bg-gradient-to-br from-purple-50/60 to-pink-50/40 backdrop-blur-xl border border-purple-200/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Repeat Customers</CardTitle>
              <TrendingUp className="h-4 w-4 text-purple-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                {customers.filter((c) => c.repeat_customer).length}
              </div>
              <p className="text-xs text-gray-500">
                {totalCount > 0
                  ? `${((customers.filter((c) => c.repeat_customer).length / totalCount) * 100).toFixed(1)}% retention`
                  : "No customers"}
              </p>
            </CardContent>
          </Card>

          {/* Avg Spend */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-emerald-500 bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Spend</CardTitle>
              <DollarSign className="h-4 w-4 text-emerald-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">
                GHS {customers.length > 0 ? (customers.reduce((sum, c) => sum + c.total_spent, 0) / customers.length).toFixed(2) : "0.00"}
              </div>
              <p className="text-xs text-gray-500">Per customer LTV</p>
            </CardContent>
          </Card>
        </div>

        {/* Main Content */}
        <Tabs defaultValue="list" className="w-full">
          <TabsList>
            <TabsTrigger value="list">Customer List</TabsTrigger>
            <TabsTrigger value="details">
              {selectedCustomer ? `${selectedCustomer.customer_name} (Details)` : "Details"}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="space-y-4">
            {/* Search and Filters */}
            <Card>
              <CardHeader>
                <CardTitle>Search & Filter</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Search</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder="Search by name, phone, or email..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {/* Repeat Customer Filter */}
                  <div>
                    <label className="text-sm font-medium block mb-2">Filter</label>
                    <Button
                      variant={filterRepeat ? "default" : "outline"}
                      onClick={() => {
                        setFilterRepeat(!filterRepeat)
                        setPagination({ ...pagination, offset: 0 })
                      }}
                      className="w-full"
                      size="sm"
                    >
                      {filterRepeat ? "Repeat Only" : "All Customers"}
                    </Button>
                  </div>

                  {/* Sort */}
                  <div>
                    <label className="text-sm font-medium block mb-2">Sort By</label>
                    <select
                      value={sortBy}
                      onChange={(e) => {
                        setSortBy(e.target.value as any)
                        setPagination({ ...pagination, offset: 0 })
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="last_purchase">Last Purchase</option>
                      <option value="total_spent">Highest Spend</option>
                      <option value="purchases">Most Orders</option>
                    </select>
                  </div>

                  {/* Results Count */}
                  <div className="flex items-end">
                    <div className="text-sm text-gray-600">
                      Showing {filteredCustomers.length} of {totalCount}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Customers Table */}
            {filteredCustomers.length === 0 ? (
              <Card>
                <CardContent className="pt-6">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      {customers.length === 0
                        ? "No customers yet. They will appear here once orders are placed."
                        : "No customers match your search criteria."}
                    </AlertDescription>
                  </Alert>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="px-4 py-2 text-left font-semibold text-gray-700">Name</th>
                          <th className="px-4 py-2 text-left font-semibold text-gray-700">Phone</th>
                          <th className="px-4 py-2 text-center font-semibold text-gray-700">Orders</th>
                          <th className="px-4 py-2 text-right font-semibold text-gray-700">Total Spent</th>
                          <th className="px-4 py-2 text-center font-semibold text-gray-700">Status</th>
                          <th className="px-4 py-2 text-center font-semibold text-gray-700">Last Purchase</th>
                          <th className="px-4 py-2 text-center font-semibold text-gray-700">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {filteredCustomers.map((customer) => (
                          <tr key={customer.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-medium text-gray-900">{customer.customer_name}</td>
                            <td className="px-4 py-3 font-mono text-sm text-gray-600">{customer.phone_number}</td>
                            <td className="px-4 py-3 text-center">
                              <Badge variant="outline">{customer.total_purchases}</Badge>
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-gray-900">
                              GHS {customer.total_spent.toFixed(2)}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {customer.repeat_customer ? (
                                <Badge className="bg-green-100 text-green-800 border-green-200">Repeat</Badge>
                              ) : (
                                <Badge className="bg-blue-100 text-blue-800 border-blue-200">New</Badge>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center text-gray-600 text-xs">
                              {new Date(customer.last_purchase_at).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleCustomerClick(customer)}
                              >
                                View
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  <div className="flex justify-between items-center mt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPagination({ ...pagination, offset: Math.max(0, pagination.offset - pagination.limit) })}
                      disabled={pagination.offset === 0}
                    >
                      Previous
                    </Button>
                    <span className="text-sm text-gray-600">
                      Page {Math.floor(pagination.offset / pagination.limit) + 1}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPagination({ ...pagination, offset: pagination.offset + pagination.limit })}
                      disabled={pagination.offset + pagination.limit >= totalCount}
                    >
                      Next
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="details" className="space-y-4">
            {selectedCustomer ? (
              <>
                {/* Customer Info */}
                <Card>
                  <CardHeader>
                    <CardTitle>{selectedCustomer.customer_name}</CardTitle>
                    <CardDescription>Customer Details</CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-600 mb-1">Phone</p>
                      <p className="font-mono text-sm font-semibold">{selectedCustomer.phone_number}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 mb-1">Email</p>
                      <p className="text-sm font-semibold">{selectedCustomer.email || "N/A"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 mb-1">Total Orders</p>
                      <p className="text-sm font-semibold">{selectedCustomer.total_purchases}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 mb-1">Total Spent</p>
                      <p className="text-sm font-semibold">GHS {selectedCustomer.total_spent.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 mb-1">First Purchase</p>
                      <p className="text-sm font-semibold">
                        {new Date(selectedCustomer.first_purchase_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 mb-1">Last Purchase</p>
                      <p className="text-sm font-semibold">
                        {new Date(selectedCustomer.last_purchase_at).toLocaleDateString()}
                      </p>
                    </div>
                    {selectedCustomer.first_source_slug && (
                      <div>
                        <p className="text-xs text-gray-600 mb-1">Source Slug</p>
                        <Badge variant="outline">{selectedCustomer.first_source_slug}</Badge>
                      </div>
                    )}
                    {selectedCustomer.preferred_network && (
                      <div>
                        <p className="text-xs text-gray-600 mb-1">Preferred Network</p>
                        <Badge>{selectedCustomer.preferred_network}</Badge>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Purchase History */}
                <Card>
                  <CardHeader>
                    <CardTitle>Purchase History</CardTitle>
                    <CardDescription>{customerHistory.length} orders</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {historyLoading ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                      </div>
                    ) : customerHistory.length === 0 ? (
                      <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>No purchase history found.</AlertDescription>
                      </Alert>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b">
                            <tr>
                              <th className="px-4 py-2 text-left font-semibold text-gray-700">Reference</th>
                              <th className="px-4 py-2 text-left font-semibold text-gray-700">Network</th>
                              <th className="px-4 py-2 text-center font-semibold text-gray-700">Package</th>
                              <th className="px-4 py-2 text-right font-semibold text-gray-700">Price</th>
                              <th className="px-4 py-2 text-center font-semibold text-gray-700">Status</th>
                              <th className="px-4 py-2 text-center font-semibold text-gray-700">Date</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {customerHistory.map((order) => (
                              <tr key={order.id} className="hover:bg-gray-50">
                                <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-900">
                                  {order.reference_code}
                                </td>
                                <td className="px-4 py-3">{order.network}</td>
                                <td className="px-4 py-3 text-center">{order.volume_gb}GB</td>
                                <td className="px-4 py-3 text-right font-semibold">GHS {order.total_price.toFixed(2)}</td>
                                <td className="px-4 py-3 text-center">
                                  <Badge
                                    className={
                                      order.order_status === "completed"
                                        ? "bg-green-100 text-green-800 border-green-200"
                                        : order.order_status === "failed"
                                          ? "bg-red-100 text-red-800 border-red-200"
                                          : "bg-yellow-100 text-yellow-800 border-yellow-200"
                                    }
                                  >
                                    {order.order_status}
                                  </Badge>
                                </td>
                                <td className="px-4 py-3 text-center text-gray-600 text-xs">
                                  {new Date(order.created_at).toLocaleDateString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>Select a customer from the list to view details.</AlertDescription>
                  </Alert>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
