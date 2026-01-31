"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Trash2, Edit, Plus, Check, X } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface Plan {
    id: string
    name: string
    description: string
    price: number
    duration_days: number
    is_active: boolean
    created_at?: string
}

export default function AdminSubscriptionsPage() {
    const router = useRouter()
    const [plans, setPlans] = useState<Plan[]>([])
    const [loading, setLoading] = useState(true)
    const [isAdmin, setIsAdmin] = useState(false)
    const [showForm, setShowForm] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [formData, setFormData] = useState({
        name: "",
        description: "",
        price: "",
        duration_days: "",
        is_active: true
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
            await loadPlans()
        } catch (error) {
            console.error("Error checking admin access:", error)
            router.push("/dashboard")
        }
    }

    const loadPlans = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const headers: HeadersInit = {}
            if (session?.access_token) {
                headers["Authorization"] = `Bearer ${session.access_token}`
            }

            const response = await fetch("/api/admin/subscription-plans", { headers })
            const data = await response.json()
            if (data.plans) {
                setPlans(data.plans)
            }
        } catch (error) {
            console.error("Error loading plans:", error)
            toast.error("Failed to load subscription plans")
        } finally {
            setLoading(false)
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!formData.name || !formData.price || !formData.duration_days) {
            toast.error("Please fill in all required fields")
            return
        }

        setIsSubmitting(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const headers: HeadersInit = { "Content-Type": "application/json" }
            if (session?.access_token) {
                headers["Authorization"] = `Bearer ${session.access_token}`
            }

            const response = await fetch("/api/admin/subscription-plans", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    ...formData,
                    id: editingId
                })
            })

            if (!response.ok) throw new Error("Failed to save plan")

            toast.success(editingId ? "Plan updated" : "Plan created")
            resetForm()
            await loadPlans()
        } catch (error) {
            console.error("Error saving plan:", error)
            toast.error("Failed to save subscription plan")
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleEdit = (plan: Plan) => {
        setFormData({
            name: plan.name,
            description: plan.description || "",
            price: plan.price.toString(),
            duration_days: plan.duration_days.toString(),
            is_active: plan.is_active
        })
        setEditingId(plan.id)
        setShowForm(true)
    }

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this plan?")) return

        try {
            const { data: { session } } = await supabase.auth.getSession()
            const headers: HeadersInit = {}
            if (session?.access_token) {
                headers["Authorization"] = `Bearer ${session.access_token}`
            }

            const response = await fetch(`/api/admin/subscription-plans?id=${id}`, {
                method: "DELETE",
                headers
            })

            if (!response.ok) throw new Error("Failed to delete plan")

            toast.success("Plan deleted")
            await loadPlans()
        } catch (error) {
            console.error("Error deleting plan:", error)
            toast.error("Failed to delete plan")
        }
    }

    const resetForm = () => {
        setFormData({ name: "", description: "", price: "", duration_days: "", is_active: true })
        setEditingId(null)
        setShowForm(false)
    }

    if (!isAdmin) return null

    return (
        <DashboardLayout>
            <div className="p-6">
                <div className="flex justify-between items-center mb-6">
                    <div>
                        <h1 className="text-2xl font-bold">Dealer Subscriptions</h1>
                        <p className="text-gray-500 text-sm">Manage dealer role subscription plans</p>
                    </div>
                    {!showForm && (
                        <Button onClick={() => setShowForm(true)} className="gap-2">
                            <Plus className="w-4 h-4" /> Add Plan
                        </Button>
                    )}
                </div>

                {showForm && (
                    <Card className="mb-8 border-amber-200">
                        <CardHeader>
                            <CardTitle>{editingId ? "Edit Plan" : "New Subscription Plan"}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="name">Plan Name (e.g., 1 Month Dealer)</Label>
                                    <Input
                                        id="name"
                                        value={formData.name}
                                        onChange={e => setFormData({ ...formData, name: e.target.value })}
                                        placeholder="Premium Dealer"
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="duration">Duration (Days)</Label>
                                    <Input
                                        id="duration"
                                        type="number"
                                        value={formData.duration_days}
                                        onChange={e => setFormData({ ...formData, duration_days: e.target.value })}
                                        placeholder="30"
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="price">Price (GHS)</Label>
                                    <Input
                                        id="price"
                                        type="number"
                                        step="0.01"
                                        value={formData.price}
                                        onChange={e => setFormData({ ...formData, price: e.target.value })}
                                        placeholder="50.00"
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="is_active">Status</Label>
                                    <div className="flex items-center gap-2 pt-2">
                                        <Button
                                            type="button"
                                            variant={formData.is_active ? "default" : "outline"}
                                            onClick={() => setFormData({ ...formData, is_active: true })}
                                            className="flex-1"
                                        >
                                            Active
                                        </Button>
                                        <Button
                                            type="button"
                                            variant={!formData.is_active ? "destructive" : "outline"}
                                            onClick={() => setFormData({ ...formData, is_active: false })}
                                            className="flex-1"
                                        >
                                            Inactive
                                        </Button>
                                    </div>
                                </div>
                                <div className="md:col-span-2 space-y-2">
                                    <Label htmlFor="description">Description (Optional)</Label>
                                    <Input
                                        id="description"
                                        value={formData.description}
                                        onChange={e => setFormData({ ...formData, description: e.target.value })}
                                        placeholder="Access to exclusive wholesale prices for all networks"
                                    />
                                </div>
                                <div className="md:col-span-2 flex justify-end gap-2 pt-4">
                                    <Button type="button" variant="ghost" onClick={resetForm}>Cancel</Button>
                                    <Button type="submit" disabled={isSubmitting}>
                                        {isSubmitting ? "Saving..." : editingId ? "Update Plan" : "Create Plan"}
                                    </Button>
                                </div>
                            </form>
                        </CardContent>
                    </Card>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {loading ? (
                        <div className="col-span-3 text-center py-12">
                            <p className="text-gray-500">Loading plans...</p>
                        </div>
                    ) : plans.length === 0 ? (
                        <div className="col-span-3 text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed">
                            <p className="text-gray-500">No subscription plans created yet.</p>
                        </div>
                    ) : (
                        plans.map(plan => (
                            <Card key={plan.id} className={plan.is_active ? "border-amber-200" : "opacity-60"}>
                                <CardHeader className="flex flex-row items-center justify-between pb-2">
                                    <CardTitle className="text-lg font-bold">{plan.name}</CardTitle>
                                    <Badge variant={plan.is_active ? "default" : "secondary"}>
                                        {plan.is_active ? "Active" : "Inactive"}
                                    </Badge>
                                </CardHeader>
                                <CardContent>
                                    <div className="mb-4">
                                        <p className="text-3xl font-bold">GHS {plan.price.toFixed(2)}</p>
                                        <p className="text-sm text-gray-500">{plan.duration_days} Days Access</p>
                                    </div>
                                    <p className="text-sm text-gray-600 mb-6 min-h-[40px]">
                                        {plan.description || "Become a dealer and unlock wholesale rates."}
                                    </p>
                                    <div className="flex justify-end gap-2">
                                        <Button variant="outline" size="sm" onClick={() => handleEdit(plan)}>
                                            <Edit className="w-4 h-4" />
                                        </Button>
                                        <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700" onClick={() => handleDelete(plan.id)}>
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    )}
                </div>
            </div>
        </DashboardLayout>
    )
}
