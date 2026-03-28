"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Crown, Check, Zap, Loader2, Sparkles, Star, PartyPopper, ShieldCheck, Users, Store as StoreIcon, AlertCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { initializePayment } from "@/lib/payment-service"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent } from "@/components/ui/dialog"

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
    const [currentSubscription, setCurrentSubscription] = useState<any>(null)
    const [daysLeft, setDaysLeft] = useState<number | null>(null)
    const [showSuccessModal, setShowSuccessModal] = useState(false)
    const [upgradesEnabled, setUpgradesEnabled] = useState<boolean>(true)

    useEffect(() => {
        fetchUserData()
        fetchPlans()
        fetchCurrentSubscription()

        const reference = searchParams.get("reference")
        if (reference) {
            verifyUpgrade(reference)
        }

        // Fetch public toggles
        fetch("/api/settings/public")
            .then((res) => res.json())
            .then((data) => {
                if (data.upgrades_enabled !== undefined) {
                    setUpgradesEnabled(data.upgrades_enabled)
                }
            })
            .catch((err) => console.error("Failed to load toggles", err))
    }, [])

    const fetchCurrentSubscription = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const headers: HeadersInit = {}
            if (session?.access_token) {
                headers["Authorization"] = `Bearer ${session.access_token}`
            }

            const response = await fetch("/api/subscriptions/current", { headers })
            const data = await response.json()
            if (data.subscription) {
                setCurrentSubscription(data.subscription)
                const end = new Date(data.subscription.end_date)
                const now = new Date()
                const diff = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
                setDaysLeft(diff > 0 ? diff : 0)
            }
        } catch (error) {
            console.error("Error fetching subscription:", error)
        }
    }

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
                setShowSuccessModal(true)
                router.refresh()
                // Wait a bit then refresh status
                setTimeout(() => {
                    fetchUserData()
                    fetchCurrentSubscription()
                }, 2000)
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

    const successBenefits = [
        { icon: <Crown className="w-5 h-5 text-amber-500" />, text: "Wholesale pricing on all data packages" },
        { icon: <Users className="w-5 h-5 text-blue-500" />, text: "Create & manage sub-agents" },
        { icon: <StoreIcon className="w-5 h-5 text-green-500" />, text: "Custom shop branding" },
        { icon: <ShieldCheck className="w-5 h-5 text-purple-500" />, text: "Priority customer support" },
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

                {!upgradesEnabled && currentRole !== 'dealer' && currentRole !== 'admin' && (
                    <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-xl text-center">
                        <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
                        <h3 className="text-lg font-bold text-red-900">Upgrades Temporarily Disabled</h3>
                        <p className="text-red-700">Account upgrades are currently paused for system maintenance. Please check back later!</p>
                    </div>
                )}

                {(currentRole === 'dealer' || currentRole === 'admin') && (
                    <div className="mb-12 p-6 bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-2xl flex flex-col md:flex-row items-center justify-between gap-6">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-amber-500 rounded-full text-white shadow-lg ring-4 ring-amber-100">
                                <Crown className="w-8 h-8" />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-amber-900">Active Dealer Access</h3>
                                <p className="text-amber-800/70">
                                    {daysLeft !== null ? (
                                        <>Your subscription expires in <span className="font-bold text-amber-600">{daysLeft} days</span>.</>
                                    ) : (
                                        "Enjoy your exclusive benefits and wholesale pricing."
                                    )}
                                </p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            {daysLeft !== null && daysLeft <= 7 && (
                                <Badge className="bg-red-100 text-red-700 border-red-200 py-2 px-4 whitespace-nowrap">
                                    EXPIRES SOON
                                </Badge>
                            )}
                            <Button variant="outline" className="border-amber-300 text-amber-700 hover:bg-amber-100" onClick={() => router.push('/dashboard')}>
                                Go to Dashboard
                            </Button>
                        </div>
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
                                            !upgradesEnabled && currentRole !== 'dealer' && currentRole !== 'admin'
                                                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                                : index === 1
                                                    ? "bg-gradient-to-r from-amber-600 to-yellow-500 hover:from-amber-700 hover:to-yellow-600 text-white shadow-lg"
                                                    : "bg-gray-900 hover:bg-black text-white"
                                        )}
                                        onClick={() => handleUpgrade(plan)}
                                        disabled={processingId === plan.id || (!upgradesEnabled && currentRole !== 'dealer' && currentRole !== 'admin')}
                                    >
                                        {processingId === plan.id ? (
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                        ) : (!upgradesEnabled && currentRole !== 'dealer' && currentRole !== 'admin') ? (
                                            "Currently Unavailable"
                                        ) : (currentRole === 'dealer' || currentRole === 'admin') ? (
                                            "Renew / Extend"
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

                {/* Congratulations Modal */}
                <Dialog open={showSuccessModal} onOpenChange={setShowSuccessModal}>
                    <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden p-0 border-0">
                        {/* Header Gradient */}
                        <div className="bg-gradient-to-br from-amber-500 via-yellow-400 to-amber-600 px-6 pt-10 pb-8 text-center relative overflow-hidden">
                            {/* Decorative circles */}
                            <div className="absolute top-0 left-0 w-32 h-32 bg-white/10 rounded-full -translate-x-1/2 -translate-y-1/2" />
                            <div className="absolute bottom-0 right-0 w-24 h-24 bg-white/10 rounded-full translate-x-1/3 translate-y-1/3" />
                            <div className="absolute top-4 right-8 w-3 h-3 bg-white/30 rounded-full animate-pulse" />
                            <div className="absolute top-12 left-10 w-2 h-2 bg-white/40 rounded-full animate-pulse" style={{ animationDelay: '0.5s' }} />
                            <div className="absolute bottom-6 left-1/4 w-2 h-2 bg-white/30 rounded-full animate-pulse" style={{ animationDelay: '1s' }} />

                            <div className="relative">
                                <div className="mx-auto w-20 h-20 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center mb-4 ring-4 ring-white/30 shadow-xl">
                                    <Crown className="w-10 h-10 text-white drop-shadow-lg" />
                                </div>
                                <div className="flex items-center justify-center gap-2 mb-2">
                                    <PartyPopper className="w-6 h-6 text-white/90" />
                                    <h2 className="text-2xl font-extrabold text-white">Congratulations!</h2>
                                    <PartyPopper className="w-6 h-6 text-white/90 scale-x-[-1]" />
                                </div>
                                <p className="text-white/90 text-lg font-semibold">You&apos;re now a DATAGOD Dealer</p>
                            </div>
                        </div>

                        {/* Body */}
                        <div className="px-6 py-6 space-y-5">
                            <p className="text-center text-gray-600 text-sm">
                                Your account has been upgraded. Here&apos;s what you&apos;ve unlocked:
                            </p>

                            <div className="space-y-3">
                                {successBenefits.map((benefit, i) => (
                                    <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100 hover:bg-gray-100 transition-colors">
                                        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-white shadow-sm flex items-center justify-center border border-gray-100">
                                            {benefit.icon}
                                        </div>
                                        <span className="text-sm font-medium text-gray-700">{benefit.text}</span>
                                    </div>
                                ))}
                            </div>

                            <div className="flex flex-col gap-2 pt-2">
                                <Button
                                    className="w-full h-12 text-base font-bold bg-gradient-to-r from-amber-600 to-yellow-500 hover:from-amber-700 hover:to-yellow-600 text-white shadow-lg"
                                    onClick={() => {
                                        setShowSuccessModal(false)
                                        router.push('/dashboard')
                                    }}
                                >
                                    <Sparkles className="w-5 h-5 mr-2" />
                                    Go to Dashboard
                                </Button>
                                <Button
                                    variant="ghost"
                                    className="w-full text-sm text-gray-500 hover:text-gray-700"
                                    onClick={() => setShowSuccessModal(false)}
                                >
                                    Stay on this page
                                </Button>
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
        </DashboardLayout>
    )
}
