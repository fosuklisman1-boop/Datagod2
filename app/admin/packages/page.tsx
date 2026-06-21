"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Trash2, Edit, Plus, Power } from "lucide-react"
import { adminPackageService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { useAdminProtected } from "@/hooks/use-admin"
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
  dealer_price?: number
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
  const { isAdmin } = useAdminProtected()
  const [packages, setPackages] = useState<Package[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    network: "",
    size: "",
    price: "",
    dealer_price: "",
    description: "",
  })

  useEffect(() => {
    if (isAdmin) loadPackages()
  }, [isAdmin])

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
          dealer_price: formData.dealer_price ? parseFloat(formData.dealer_price) : null,
          description: formData.description,
        })
        toast.success("Package updated successfully")
      } else {
        await adminPackageService.createPackage({
          network: formData.network,
          size: cleanSize,
          price: parseFloat(formData.price),
          dealer_price: formData.dealer_price ? parseFloat(formData.dealer_price) : null,
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
      dealer_price: pkg.dealer_price?.toString() || "",
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
    setFormData({ network: "", size: "", price: "", dealer_price: "", description: "" })
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
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-primary to-primary bg-clip-text text-transparent">Package Management</h1>
            <p className="text-muted-foreground mt-1">Create, edit, and delete data packages</p>
          </div>
          <Button
            onClick={() => !showForm ? setShowForm(true) : resetForm()}
            className="bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary"
          >
            <Plus className="w-4 h-4 mr-2" />
            {showForm ? "Cancel" : "Add Package"}
          </Button>
        </div>

        {/* Add/Edit Form */}
        {showForm && (
          <Card className="border-2 border-border bg-card backdrop-blur-xl">
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
                    className="w-full mt-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring bg-card"
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
                  <Label htmlFor="dealer_price">Dealer Price (GHS)</Label>
                  <Input
                    id="dealer_price"
                    type="number"
                    placeholder="Leave blank if no dealer price"
                    value={formData.dealer_price}
                    onChange={(e) => setFormData({ ...formData, dealer_price: e.target.value })}
                    className="mt-1"
                    step="0.01"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                  className="flex-1 bg-success hover:bg-success/90"
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
        <Card className="bg-card backdrop-blur-xl border border-primary/20">
          <CardHeader>
            <CardTitle>All Packages ({formatCount(packages.length)})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-card backdrop-blur border-b border-primary/20">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Network</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Size</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Price</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Dealer Price</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Description</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Available</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100/40">
                  {packages.map((pkg) => (
                    <tr key={pkg.id} className="hover:bg-primary/10 backdrop-blur transition-colors">
                      <td className="px-6 py-4 font-medium text-foreground">{pkg.network}</td>
                      <td className="px-6 py-4 text-foreground">{pkg.size}</td>
                      <td className="px-6 py-4 font-semibold text-primary">GHS {(pkg.price || 0).toFixed(2)}</td>
                      <td className="px-6 py-4 font-semibold text-primary">{pkg.dealer_price ? `GHS ${pkg.dealer_price.toFixed(2)}` : "-"}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{pkg.description || "-"}</td>
                      <td className="px-6 py-4">
                        <Button
                          size="sm"
                          onClick={() => toggleAvailability(pkg.id, pkg.is_available !== false)}
                          className={`${pkg.is_available !== false
                            ? "bg-success hover:bg-success/90"
                            : "bg-muted-foreground hover:bg-muted-foreground/90"
                            } text-primary-foreground`}
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
                          className="text-primary hover:text-primary hover:bg-primary/5"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDelete(pkg.id)}
                          disabled={isDeletingId === pkg.id}
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
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
