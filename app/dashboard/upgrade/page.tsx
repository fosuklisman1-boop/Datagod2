"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Crown, Check, Zap, Loader2, Sparkles, Star } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { initializePayment } from "@/lib/payment-service"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

interface Plan {
    id: string
    name: string
    description: string
    price: number
    duration_days: number
}

export default function UpgradePage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const [plans, setPlans] = useState<Plan[]>([])
    const [loading, setLoading] = useState(true)
    const [processingId, setProcessingId] = useState<string | null>(null)
    const [currentRole, setCurrentRole] = useState<string | null>(null)
    const [userEmail, setUserEmail] = useState<string | null>(null)
    const [userId, setUserId] = useState<string | null>(null)

    useEffect(() => {
        fetchUserData()
        fetchPlans()

        const reference = searchParams.get("reference")
        if (reference) {
            verifyUpgrade(reference)
        }
    }, [])

    const fetchUserData = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser()
            if (user) {
                setUserId(user.id)
                setUserEmail(user.email || "")
                const { data: profile } = await supabase
                    .from("users")
                    .select("role")
                    .eq("id", user.id)
                    .single()
                setCurrentRole(profile?.role || "user")
            }
        } catch (error) {
            console.error("Error fetching user data:", error)
        }
    }

    const fetchPlans = async () => {
        try {
            const response = await fetch("/api/subscriptions/plans")
            const data = await response.json()
            if (data.plans) {
                setPlans(data.plans)
            }
        } catch (error) {
            console.error("Error fetching plans:", error)
            toast.error("Failed to load subscription plans")
        } finally {
            setLoading(false)
        }
    }

    const verifyUpgrade = async (reference: string) => {
        toast.loading("Verifying your upgrade...", { id: "verify-upgrade" })
        try {
            const response = await fetch("/api/payments/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reference })
            })

            if (response.ok) {
                toast.success("Welcome to the Dealer Club!", { id: "verify-upgrade" })
                router.refresh()
                // Wait a bit then refresh status
                setTimeout(fetchUserData, 2000)
            } else {
                toast.error("Payment verification failed", { id: "verify-upgrade" })
            }
        } catch (error) {
            toast.error("Error verifying payment", { id: "verify-upgrade" })
        }
    }

    const handleUpgrade = async (plan: Plan) => {
        if (!userId || !userEmail) {
            toast.error("Please log in to upgrade")
            return
        }

        setProcessingId(plan.id)
        try {
            const result = await initializePayment({
                userId,
                email: userEmail,
                amount: plan.price,
                type: "dealer_upgrade",
                planId: plan.id
            })

            if (result.authorizationUrl) {
                window.location.href = result.authorizationUrl
            } else {
                throw new Error("Missing authorization URL")
            }
        } catch (error) {
            console.error("Upgrade error:", error)
            toast.error("Failed to initialize upgrade payment")
        } finally {
            setProcessingId(null)
        }
    }

    const features = [
        "Exclusive Wholesale Pricing",
        "Crown Badge on Profile",
        "Priority Customer Support",
        "Manage Sub-Agents",
        "Bulk Order Access",
        "Custom Shop Branding"
    ]

    return (
        <DashboardLayout>
            <div className="p-6 max-w-6xl mx-auto">
                <div className="text-center mb-12">
                    <Badge className="mb-4 bg-amber-100 text-amber-700 hover:bg-amber-100 transition-colors py-1 px-4 border-amber-200">
                        PREMIUM MEMBERSHIP
                    </Badge>
                    <h1 className="text-4xl md:text-5xl font-extrabold mb-4 bg-gradient-to-r from-amber-600 via-yellow-500 to-amber-600 bg-clip-text text-transparent">
                        Become a DATAGOD Dealer
                    </h1>
                    <p className="text-gray-600 text-lg max-w-2xl mx-auto">
                        Unlock wholesale rates, sub-agent management, and exclusive features to grow your business.
                    </p>
                </div>

                {currentRole === 'dealer' && (
                    <div className="mb-12 p-6 bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-2xl flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-amber-500 rounded-full text-white">
                                <Crown className="w-8 h-8" />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-amber-900">You are a Dealer!</h3>
                                <p className="text-amber-800/70">Enjoy your exclusive benefits and wholesale pricing.</p>
                            </div>
                        </div>
                        <Button variant="outline" className="border-amber-300 text-amber-700 hover:bg-amber-100" onClick={() => router.push('/dashboard')}>
                            Go to Dashboard
                        </Button>
                    </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
                    {loading ? (
                        Array(3).fill(0).map((_, i) => (
                            <Card key={i} className="animate-pulse border-gray-100 h-[450px]">
                                <CardHeader className="space-y-4">
                                    <div className="h-6 bg-gray-200 rounded w-1/2"></div>
                                    <div className="h-4 bg-gray-100 rounded w-full"></div>
                                </CardHeader>
                                <CardContent className="space-y-6">
                                    <div className="h-10 bg-gray-200 rounded w-3/4 mx-auto"></div>
                                    <div className="space-y-2">
                                        {Array(4).fill(0).map((_, j) => (
                                            <div key={j} className="h-3 bg-gray-100 rounded w-full"></div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    ) : plans.length === 0 ? (
                        <div className="col-span-3 text-center py-20 bg-gray-50 rounded-3xl border-2 border-dashed border-gray-200">
                            <Star className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                            <p className="text-gray-500 text-xl font-medium">New dealer plans coming soon!</p>
                        </div>
                    ) : (
                        plans.map((plan, index) => (
                            <Card
                                key={plan.id}
                                className={cn(
                                    "relative flex flex-col transition-all duration-300 hover:scale-105 hover:shadow-2xl border-2",
                                    index === 1 ? "border-amber-400 shadow-xl" : "border-gray-100"
                                )}
                            >
                                {index === 1 && (
                                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-gradient-to-r from-amber-600 to-yellow-500 text-white text-xs font-bold px-4 py-1 rounded-full shadow-lg z-10 flex items-center gap-1">
                                        <Sparkles className="w-3 h-3" /> MOST POPULAR
                                    </div>
                                )}
                                <CardHeader className="text-center pt-8">
                                    <CardTitle className="text-2xl font-bold">{plan.name}</CardTitle>
                                    <CardDescription className="text-gray-500 mt-2">{plan.duration_days} Days Access</CardDescription>
                                </CardHeader>
                                <CardContent className="flex-grow flex flex-col">
                                    <div className="text-center mb-8">
                                        <div className="flex items-baseline justify-center gap-1">
                                            <span className="text-gray-500 text-lg">GHS</span>
                                            <span className="text-5xl font-black text-gray-900">{plan.price.toFixed(2)}</span>
                                        </div>
                                    </div>
                                    <ul className="space-y-4 mb-8">
                                        {features.map((feature, i) => (
                                            <li key={i} className="flex items-start gap-3">
                                                <div className="mt-1 p-0.5 bg-green-100 rounded-full flex-shrink-0">
                                                    <Check className="w-3 h-3 text-green-600" />
                                                </div>
                                                <span className="text-sm text-gray-600">{feature}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </CardContent>
                                <CardFooter className="pb-8">
                                    <Button
                                        className={cn(
                                            "w-full h-12 text-lg font-bold transition-all duration-300",
                                            index === 1
                                                ? "bg-gradient-to-r from-amber-600 to-yellow-500 hover:from-amber-700 hover:to-yellow-600 text-white shadow-lg"
                                                : "bg-gray-900 hover:bg-black text-white"
                                        )}
                                        onClick={() => handleUpgrade(plan)}
                                        disabled={processingId === plan.id || currentRole === 'dealer'}
                                    >
                                        {processingId === plan.id ? (
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                        ) : currentRole === 'dealer' ? (
                                            "Already Active"
                                        ) : (
                                            "Upgrade Now"
                                        )}
                                    </Button>
                                </CardFooter>
                            </Card>
                        ))
                    )}
                </div>

                <div className="bg-gray-50 rounded-3xl p-8 text-center border border-gray-100 mb-16">
                    <h2 className="text-2xl font-bold mb-4 flex items-center justify-center gap-2">
                        <Zap className="w-6 h-6 text-amber-500 fill-amber-500" /> Fast & Secure
                    </h2>
                    <p className="text-gray-600 mb-8 max-w-xl mx-auto">
                        Upgrade your account in seconds using card, mobile money or bank transfer via Paystack. Your benefits start immediately.
                    </p>
                    <div className="flex flex-wrap justify-center gap-8 opacity-50 grayscale hover:grayscale-0 transition-all duration-500">
                        <img src="/paystack-badge.png" alt="Paystack" className="h-8 object-contain" />
                        {/* Fallback text if image not found */}
                        <span className="text-sm font-bold text-gray-400">SECURE PAYMENTS BY PAYSTACK</span>
                    </div>
                </div>
            </div>
        </DashboardLayout>
    )
}
