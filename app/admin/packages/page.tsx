"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Trash2, Edit, Plus, Power } from "lucide-react"
import { adminPackageService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

// Format large numbers with K/M suffix
const formatCount = (num: number): string => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 10000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toLocaleString()
}

interface Package {
  id: string
  network: string
  size: string
  price: number
  description?: string
  is_available?: boolean
  created_at?: string
}

const AVAILABLE_NETWORKS = [
  "MTN",
  "Telecel",
  "AT - iShare",
  "AT - BigTime",
]

export default function AdminPackagesPage() {
  const router = useRouter()
  const [packages, setPackages] = useState<Package[]>([])
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    network: "",
    size: "",
    price: "",
    description: "",
  })

  useEffect(() => {
    checkAdminAccess()
  }, [])

  const checkAdminAccess = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const role = user?.user_metadata?.role

      if (role !== "admin") {
        toast.error("Unauthorized access")
        router.push("/dashboard")
        return
      }

      setIsAdmin(true)
      await loadPackages()
    } catch (error) {
      console.error("Error checking admin access:", error)
      router.push("/dashboard")
    }
  }

  const loadPackages = async () => {
    try {
      const data = await adminPackageService.getAllPackages()
      setPackages(data || [])
    } catch (error) {
      console.error("Error loading packages:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load packages"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async () => {
    if (!formData.network || !formData.size || !formData.price) {
      toast.error("Please fill in all required fields")
      return
    }

    setIsSubmitting(true)
    try {
      // Clean size by removing "GB" suffix if present
      const cleanSize = formData.size.toString().toUpperCase().replace(/\s*GB\s*$/, "")
      
      if (editingId) {
        await adminPackageService.updatePackage(editingId, {
          network: formData.network,
          size: cleanSize,
          price: parseFloat(formData.price),
          description: formData.description,
        })
        toast.success("Package updated successfully")
      } else {
        await adminPackageService.createPackage({
          network: formData.network,
          size: cleanSize,
          price: parseFloat(formData.price),
          description: formData.description,
        })
        toast.success("Package created successfully")
      }

      resetForm()
      await loadPackages()
    } catch (error: any) {
      console.error("Error saving package:", error)
      toast.error(error.message || "Failed to save package")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEdit = (pkg: Package) => {
    setFormData({
      network: pkg.network,
      size: pkg.size,
      price: pkg.price.toString(),
      description: pkg.description || "",
    })
    setEditingId(pkg.id)
    setShowForm(true)
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this package?")) return

    setIsDeletingId(id)
    try {
      await adminPackageService.deletePackage(id)
      toast.success("Package deleted successfully")
      await loadPackages()
    } catch (error: any) {
      console.error("Error deleting package:", error)
      toast.error(error.message || "Failed to delete package")
    } finally {
      setIsDeletingId(null)
    }
  }

  const toggleAvailability = async (packageId: string, currentStatus: boolean) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/admin/packages/toggle-availability", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          packageId,
          isAvailable: !currentStatus,
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to update availability")
      }

      toast.success(`Package ${!currentStatus ? "enabled" : "disabled"} successfully`)
      await loadPackages()
    } catch (error: any) {
      console.error("Error toggling availability:", error)
      toast.error(error.message || "Failed to update package availability")
    }
  }

  const resetForm = () => {
    setFormData({ network: "", size: "", price: "", description: "" })
    setEditingId(null)
    setShowForm(false)
  }

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">Package Management</h1>
            <p className="text-gray-500 mt-1">Create, edit, and delete data packages</p>
          </div>
          <Button
            onClick={() => !showForm ? setShowForm(true) : resetForm()}
            className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            {showForm ? "Cancel" : "Add Package"}
          </Button>
        </div>

        {/* Add/Edit Form */}
        {showForm && (
          <Card className="border-2 border-blue-300/50 bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl">
            <CardHeader>
              <CardTitle>{editingId ? "Edit Package" : "Add New Package"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="network">Network *</Label>
                  <select
                    id="network"
                    aria-label="Select network"
                    value={formData.network}
                    onChange={(e) => setFormData({ ...formData, network: e.target.value })}
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="">Choose a network...</option>
                    {AVAILABLE_NETWORKS.map((network) => (
                      <option key={network} value={network}>
                        {network}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="size">Size *</Label>
                  <Input
                    id="size"
                    placeholder="e.g., 1GB, 5GB, 10GB"
                    value={formData.size}
                    onChange={(e) => setFormData({ ...formData, size: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="price">Price (GHS) *</Label>
                  <Input
                    id="price"
                    type="number"
                    placeholder="e.g., 19.50"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                    className="mt-1"
                    step="0.01"
                  />
                </div>
                <div>
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    placeholder="Optional description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                >
                  {isSubmitting ? (
                    <>
                      <span className="animate-spin mr-2">⟳</span>
                      Saving...
                    </>
                  ) : (
                    <>{editingId ? "Update" : "Create"} Package</>
                  )}
                </Button>
                <Button
                  onClick={resetForm}
                  variant="outline"
                  className="flex-1"
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Packages Table */}
        <Card className="bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
          <CardHeader>
            <CardTitle>All Packages ({formatCount(packages.length)})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gradient-to-r from-blue-100/60 to-cyan-100/60 backdrop-blur border-b border-blue-200/40">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Network</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Size</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Price</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Description</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Available</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100/40">
                  {packages.map((pkg) => (
                    <tr key={pkg.id} className="hover:bg-blue-100/30 backdrop-blur transition-colors">
                      <td className="px-6 py-4 font-medium text-gray-900">{pkg.network}</td>
                      <td className="px-6 py-4 text-gray-900">{pkg.size}</td>
                      <td className="px-6 py-4 font-semibold text-blue-600">GHS {(pkg.price || 0).toFixed(2)}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{pkg.description || "-"}</td>
                      <td className="px-6 py-4">
                        <Button
                          size="sm"
                          onClick={() => toggleAvailability(pkg.id, pkg.is_available !== false)}
                          className={`${
                            pkg.is_available !== false
                              ? "bg-green-600 hover:bg-green-700"
                              : "bg-gray-400 hover:bg-gray-500"
                          } text-white`}
                        >
                          <Power className="w-4 h-4 mr-1" />
                          {pkg.is_available !== false ? "Enabled" : "Disabled"}
                        </Button>
                      </td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleEdit(pkg)}
                          className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDelete(pkg.id)}
                          disabled={isDeletingId === pkg.id}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          {isDeletingId === pkg.id ? (
                            <span className="animate-spin">⏳</span>
                          ) : (
                            <Trash2 className="w-4 h-4" />
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
      </div>
    </DashboardLayout>
  )
}
