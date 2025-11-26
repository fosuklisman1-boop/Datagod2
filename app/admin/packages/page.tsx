"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Trash2, Edit, Plus } from "lucide-react"
import { adminPackageService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface Package {
  id: string
  network: string
  size: string
  price: number
  description?: string
  created_at?: string
}

const AVAILABLE_NETWORKS = [
  "MTN",
  "Telecel",
  "AT",
  "iShare",
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
      toast.error("Failed to load packages")
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async () => {
    if (!formData.network || !formData.size || !formData.price) {
      toast.error("Please fill in all required fields")
      return
    }

    try {
      if (editingId) {
        await adminPackageService.updatePackage(editingId, {
          network: formData.network,
          size: formData.size,
          price: parseFloat(formData.price),
          description: formData.description,
        })
        toast.success("Package updated successfully")
      } else {
        await adminPackageService.createPackage({
          network: formData.network,
          size: formData.size,
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

    try {
      await adminPackageService.deletePackage(id)
      toast.success("Package deleted successfully")
      await loadPackages()
    } catch (error: any) {
      console.error("Error deleting package:", error)
      toast.error(error.message || "Failed to delete package")
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
            <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">Package Management</h1>
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
                  className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                >
                  {editingId ? "Update" : "Create"} Package
                </Button>
                <Button
                  onClick={resetForm}
                  variant="outline"
                  className="flex-1"
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
            <CardTitle>All Packages ({packages.length})</CardTitle>
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
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100/40">
                  {packages.map((pkg) => (
                    <tr key={pkg.id} className="hover:bg-blue-100/30 backdrop-blur transition-colors">
                      <td className="px-6 py-4 font-medium text-gray-900">{pkg.network}</td>
                      <td className="px-6 py-4 text-gray-900">{pkg.size}</td>
                      <td className="px-6 py-4 font-semibold text-blue-600">GHS {pkg.price.toFixed(2)}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{pkg.description || "-"}</td>
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
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
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
