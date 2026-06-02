"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Crown, Check, Zap, Loader2, Sparkles, Star, PartyPopper, ShieldCheck, Users, Store as StoreIcon, AlertCircle, List, TrendingDown, Tag } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { initializePayment } from "@/lib/payment-service"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useResendCooldown } from "@/lib/use-resend-cooldown"

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
    const [showPriceList, setShowPriceList] = useState(false)
    const [priceListPackages, setPriceListPackages] = useState<any[]>([])
    const [priceListLoading, setPriceListLoading] = useState(false)
    const [priceListNetwork, setPriceListNetwork] = useState<string | null>(null)
    const verifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Wallet/upgrade protection gate → OTP-verified direct charge for upgrades.
    const [walletLock, setWalletLock] = useState(false)
    const [paymentPhone, setPaymentPhone] = useState("")
    const [otpSent, setOtpSent] = useState(false)
    const [otpCode, setOtpCode] = useState("")
    const [otpVerified, setOtpVerified] = useState(false)
    const [sendingOtp, setSendingOtp] = useState(false)
    const [verifyingOtp, setVerifyingOtp] = useState(false)
    const [upgradeFlow, setUpgradeFlow] = useState<null | { state: "collect" | "awaiting" | "success" | "failed"; plan?: Plan; reference?: string; message?: string }>(null)
    const otpCooldown = useResendCooldown()

    useEffect(() => {
      return () => {
        if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current)
      }
    }, [])

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

        // Wallet/upgrade protection gate
        fetch("/api/public/turnstile-status")
            .then((r) => r.ok ? r.json() : { wallet_lock: false })
            .then((d) => setWalletLock(d.wallet_lock === true))
            .catch(() => setWalletLock(false))
    }, [])

    // One-time OTP: auto-skip if the payment number was already verified.
    useEffect(() => {
        if (!upgradeFlow || upgradeFlow.state !== "collect" || otpVerified) return
        const digits = paymentPhone.replace(/\D/g, "")
        if (!/^0?\d{9}$/.test(digits)) return
        const t = setTimeout(() => {
            fetch("/api/public/phone-verified", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: paymentPhone }),
            }).then(r => r.ok ? r.json() : { verified: false }).then(d => { if (d.verified) setOtpVerified(true) }).catch(() => {})
        }, 600)
        return () => clearTimeout(t)
    }, [paymentPhone, upgradeFlow, otpVerified])

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
                const role = profile?.role || "user"
                setCurrentRole(role)

                // Dealers with no active subscription (permanent dealers) have no downgrade
                // date — redirect them away since renewal doesn't apply to them.
                if (role === 'dealer') {
                    const { data: sub } = await supabase
                        .from("user_subscriptions")
                        .select("id")
                        .eq("user_id", user.id)
                        .eq("status", "active")
                        .maybeSingle()
                    if (!sub) {
                        router.replace('/dashboard')
                        return
                    }
                }
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
                verifyTimerRef.current = setTimeout(() => {
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

    const handleViewPriceList = async () => {
        if (priceListPackages.length > 0) {
            setShowPriceList(true)
            return
        }
        setPriceListLoading(true)
        try {
            const res = await fetch("/api/shop/dealer-price-list")
            const data = await res.json()
            if (data.packages) {
                setPriceListPackages(data.packages)
                const networks = Array.from(new Set<string>(data.packages.map((p: any) => p.network)))
                setPriceListNetwork(networks[0] ?? null)
            }
        } catch {
            toast.error("Failed to load price list")
        } finally {
            setPriceListLoading(false)
            setShowPriceList(true)
        }
    }

    const handleUpgrade = async (plan: Plan) => {
        if (!userId || !userEmail) {
            toast.error("Please log in to upgrade")
            return
        }

        // Protection gate ON → collect + verify a payment number, then direct charge.
        if (walletLock) {
            setPaymentPhone(""); setOtpSent(false); setOtpVerified(false); setOtpCode("")
            setUpgradeFlow({ state: "collect", plan })
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

    const handleSendOtp = async () => {
        const digits = paymentPhone.replace(/\D/g, "")
        if (!/^0?\d{9}$/.test(digits)) { toast.error("Enter a valid Mobile Money number first"); return }
        setSendingOtp(true)
        try {
            const res = await fetch("/api/auth/send-phone-otp", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: paymentPhone }),
            })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) { toast.error(d?.error || "Failed to send code"); return }
            toast.success("Verification code sent"); setOtpSent(true); otpCooldown.start()
        } catch { toast.error("Network error") } finally { setSendingOtp(false) }
    }

    const handleVerifyOtp = async () => {
        if (!otpCode || otpCode.length < 4) { toast.error("Enter the code from your SMS"); return }
        setVerifyingOtp(true)
        try {
            const res = await fetch("/api/auth/verify-phone-otp", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: paymentPhone, code: otpCode.trim() }),
            })
            const d = await res.json().catch(() => ({}))
            if (!res.ok || !d.verified) { toast.error(d?.error || "Incorrect code"); return }
            toast.success("Payment number verified ✓"); setOtpVerified(true)
        } catch { toast.error("Network error") } finally { setVerifyingOtp(false) }
    }

    const pollUpgradeStatus = (reference: string, plan: Plan) => {
        const started = Date.now()
        const TIMEOUT_MS = 4 * 60 * 1000
        const tick = async () => {
            if (Date.now() - started > TIMEOUT_MS) {
                setUpgradeFlow({ state: "failed", message: "Payment timed out. If you approved the prompt, your upgrade will still be applied — refresh in a moment, or try again." })
                return
            }
            try {
                const res = await fetch(`/api/payments/momo-status?reference=${encodeURIComponent(reference)}`)
                const d = await res.json().catch(() => ({ status: "pending" }))
                if (d.status === "completed") {
                    setUpgradeFlow({ state: "success", plan, reference })
                    verifyTimerRef.current = setTimeout(() => { fetchUserData(); fetchCurrentSubscription() }, 1500)
                    return
                }
                if (d.status === "failed") { setUpgradeFlow({ state: "failed", message: "Payment was not completed. Please try again." }); return }
            } catch { /* keep polling */ }
            setTimeout(tick, 3000)
        }
        setTimeout(tick, 3000)
    }

    const confirmUpgradeDirectCharge = async () => {
        const plan = upgradeFlow?.plan
        if (!plan || !userEmail) return
        if (!otpVerified) { toast.error("Verify your Mobile Money number first"); return }
        setProcessingId(plan.id)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            if (!session?.access_token) { throw new Error("Your session expired. Please refresh and sign in again.") }
            const res = await fetch("/api/payments/initialize", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
                body: JSON.stringify({ email: userEmail, amount: plan.price, type: "dealer_upgrade", planId: plan.id, momoDirect: true, paymentPhone }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.success) { throw new Error(data?.error || "Could not start the Mobile Money charge. Please try again.") }
            setUpgradeFlow({ state: "awaiting", plan, reference: data.reference })
            pollUpgradeStatus(data.reference, plan)
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to start upgrade charge")
        } finally {
            setProcessingId(null)
        }
    }

    const features = [
        "Data Bundles — MTN, AirtelTigo & Telecel",
        "Airtime Top-up Sales",
        "Results Checker Vouchers (WASSCE / BECE)",
        "Online Web Storefront",
        "USSD Shop (*714# Integration)",
        "Sub-Agent Network & Catalog",
        "Bulk Order Processing",
        "Exclusive Wholesale Pricing",
        "Custom Shop Branding",
        "Priority Customer Support",
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
                                <CardFooter className="pb-8 flex flex-col gap-3">
                                    <Button
                                        variant="outline"
                                        className="w-full h-10 font-semibold border-amber-300 text-amber-700 hover:bg-amber-50 hover:border-amber-400 transition-all"
                                        onClick={handleViewPriceList}
                                    >
                                        {priceListLoading ? (
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        ) : (
                                            <List className="w-4 h-4 mr-2" />
                                        )}
                                        View Price List
                                    </Button>
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

                {/* Dealer Price List Modal */}
                <Dialog open={showPriceList} onOpenChange={setShowPriceList}>
                    <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0">
                        <DialogHeader className="px-6 pt-6 pb-4 border-b flex-shrink-0">
                            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
                                <Tag className="w-5 h-5 text-amber-500" />
                                Dealer Price List
                            </DialogTitle>
                            <p className="text-sm text-gray-500 mt-1">Exclusive wholesale pricing available to all DATAGOD dealers</p>
                        </DialogHeader>

                        {priceListLoading ? (
                            <div className="flex items-center justify-center py-20">
                                <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
                            </div>
                        ) : (
                            <div className="flex flex-col overflow-hidden flex-1">
                                {/* Network Tabs */}
                                {(() => {
                                    const networks = Array.from(new Set<string>(priceListPackages.map((p) => p.network)))
                                    return (
                                        <>
                                            <div className="flex gap-1 px-6 pt-4 pb-2 border-b flex-shrink-0 overflow-x-auto">
                                                {networks.map((net) => (
                                                    <button
                                                        key={net}
                                                        onClick={() => setPriceListNetwork(net)}
                                                        className={cn(
                                                            "px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap transition-all",
                                                            priceListNetwork === net
                                                                ? "bg-amber-500 text-white shadow"
                                                                : "bg-gray-100 text-gray-600 hover:bg-amber-50 hover:text-amber-700"
                                                        )}
                                                    >
                                                        {net}
                                                    </button>
                                                ))}
                                            </div>

                                            <div className="overflow-y-auto flex-1 px-6 py-4">
                                                {priceListNetwork && (
                                                    <table className="w-full text-sm">
                                                        <thead>
                                                            <tr className="text-left">
                                                                <th className="pb-3 font-semibold text-gray-500 uppercase text-xs tracking-wide">Package</th>
                                                                <th className="pb-3 font-semibold text-gray-500 uppercase text-xs tracking-wide text-right">Regular</th>
                                                                <th className="pb-3 font-semibold text-amber-600 uppercase text-xs tracking-wide text-right">Dealer Price</th>
                                                                <th className="pb-3 font-semibold text-green-600 uppercase text-xs tracking-wide text-right">Savings</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-gray-100">
                                                            {priceListPackages
                                                                .filter((p) => p.network === priceListNetwork)
                                                                .sort((a, b) => {
                                                                    const toMb = (s: string) => {
                                                                        const m = s.trim().match(/(\d+(?:\.\d+)?)\s*(MB|GB|TB)/i)
                                                                        if (!m) { const n = parseFloat(s); return isNaN(n) ? 0 : n * 1024 }
                                                                        const v = parseFloat(m[1])
                                                                        if (m[2].toUpperCase() === 'MB') return v
                                                                        if (m[2].toUpperCase() === 'TB') return v * 1024 * 1024
                                                                        return v * 1024
                                                                    }
                                                                    return toMb(a.size) - toMb(b.size)
                                                                })
                                                                .map((pkg) => {
                                                                    const savings = pkg.regular_price - pkg.dealer_price
                                                                    return (
                                                                        <tr key={pkg.id} className="hover:bg-amber-50/50 transition-colors">
                                                                            <td className="py-3 pr-4">
                                                                                <div className="font-bold text-gray-900">{pkg.size}GB</div>
                                                                                {pkg.description && (
                                                                                    <div className="text-xs text-gray-400 mt-0.5 truncate max-w-[160px]">{pkg.description}</div>
                                                                                )}
                                                                            </td>
                                                                            <td className="py-3 text-right text-gray-400 line-through">
                                                                                GHS {pkg.regular_price.toFixed(2)}
                                                                            </td>
                                                                            <td className="py-3 text-right font-black text-amber-600 text-base">
                                                                                GHS {pkg.dealer_price.toFixed(2)}
                                                                            </td>
                                                                            <td className="py-3 text-right">
                                                                                {pkg.has_discount ? (
                                                                                    <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full">
                                                                                        <TrendingDown className="w-3 h-3" />
                                                                                        GHS {savings.toFixed(2)}
                                                                                    </span>
                                                                                ) : (
                                                                                    <span className="text-gray-300 text-xs">—</span>
                                                                                )}
                                                                            </td>
                                                                        </tr>
                                                                    )
                                                                })}
                                                        </tbody>
                                                    </table>
                                                )}
                                            </div>
                                        </>
                                    )
                                })()}
                            </div>
                        )}

                        <div className="px-6 py-4 border-t flex-shrink-0 bg-amber-50/60">
                            <p className="text-xs text-amber-700 text-center font-medium">
                                These prices are available exclusively to active DATAGOD Dealers.
                            </p>
                        </div>
                    </DialogContent>
                </Dialog>

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

                {/* Direct-charge upgrade flow (protection gate ON) */}
                <Dialog open={!!upgradeFlow} onOpenChange={(o) => { if (!o) setUpgradeFlow(null) }}>
                    <DialogContent className="max-w-md">
                        {upgradeFlow?.state === "collect" && (
                            <div className="space-y-4">
                                <DialogHeader>
                                    <DialogTitle>Verify your Mobile Money number</DialogTitle>
                                </DialogHeader>
                                <p className="text-sm text-gray-600">
                                    Upgrade to <span className="font-semibold">{upgradeFlow.plan?.name}</span> — GHS {Number(upgradeFlow.plan?.price || 0).toFixed(2)}. The payment prompt is sent to the number you verify below.
                                </p>
                                <div>
                                    <label className="text-sm font-semibold text-purple-900">Mobile Money number to pay from *</label>
                                    <input
                                        type="tel"
                                        inputMode="numeric"
                                        placeholder="0241234567"
                                        value={paymentPhone}
                                        onChange={(e) => { setPaymentPhone(e.target.value); if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode(""); otpCooldown.reset() } }}
                                        disabled={otpVerified}
                                        className="mt-1 w-full rounded-md border border-purple-200 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
                                    />
                                </div>
                                {!otpVerified ? (
                                    !otpSent ? (
                                        <Button type="button" onClick={handleSendOtp} disabled={sendingOtp} className="w-full bg-purple-600 hover:bg-purple-700 text-white">
                                            {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : "Send verification code"}
                                        </Button>
                                    ) : (
                                        <div className="space-y-2">
                                            <input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otpCode}
                                                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                                className="w-full rounded-md border bg-white px-3 py-2 text-center text-lg tracking-[0.4em] font-mono focus:outline-none focus:ring-2 focus:ring-purple-400" />
                                            <div className="flex gap-2">
                                                <Button type="button" onClick={handleVerifyOtp} disabled={verifyingOtp || otpCode.length < 4} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white">
                                                    {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                                                </Button>
                                                <Button type="button" variant="outline" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>{otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}</Button>
                                            </div>
                                        </div>
                                    )
                                ) : (
                                    <div className="p-3 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
                                        <ShieldCheck className="w-5 h-5 text-green-600" />
                                        <span className="text-sm font-medium text-green-900">Payment number verified ✓</span>
                                    </div>
                                )}
                                <Button
                                    onClick={confirmUpgradeDirectCharge}
                                    disabled={!otpVerified || processingId === upgradeFlow.plan?.id}
                                    className="w-full bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-white"
                                >
                                    {processingId === upgradeFlow.plan?.id ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Starting…</>) : `Pay GHS ${Number(upgradeFlow.plan?.price || 0).toFixed(2)}`}
                                </Button>
                            </div>
                        )}

                        {upgradeFlow?.state === "awaiting" && (
                            <div className="text-center space-y-4 py-2">
                                <div className="mx-auto w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center">
                                    <Loader2 className="w-8 h-8 text-purple-600 animate-spin" />
                                </div>
                                <DialogHeader><DialogTitle className="text-center">Approve the prompt on your phone</DialogTitle></DialogHeader>
                                <p className="text-sm text-gray-600">
                                    We sent a Mobile Money prompt to <span className="font-semibold">{paymentPhone}</span>. Enter your PIN to approve GHS {Number(upgradeFlow.plan?.price || 0).toFixed(2)}.
                                </p>
                                <div className="flex items-center justify-center gap-2 text-xs text-gray-500"><Loader2 className="w-3 h-3 animate-spin" /> Waiting for confirmation…</div>
                            </div>
                        )}

                        {upgradeFlow?.state === "success" && (
                            <div className="text-center space-y-4 py-2">
                                <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                                    <PartyPopper className="w-9 h-9 text-green-600" />
                                </div>
                                <DialogHeader><DialogTitle className="text-center">Welcome to the Dealer Club 🎉</DialogTitle></DialogHeader>
                                <p className="text-sm text-gray-600">Your upgrade is active. Enjoy wholesale pricing and dealer tools.</p>
                                <Button onClick={() => { setUpgradeFlow(null); router.refresh() }} className="w-full bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-white">Done</Button>
                            </div>
                        )}

                        {upgradeFlow?.state === "failed" && (
                            <div className="text-center space-y-4 py-2">
                                <div className="mx-auto w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
                                    <AlertCircle className="w-9 h-9 text-red-600" />
                                </div>
                                <DialogHeader><DialogTitle className="text-center">Payment not completed</DialogTitle></DialogHeader>
                                <p className="text-sm text-gray-600">{upgradeFlow.message || "The prompt was not approved. Please try again."}</p>
                                <Button variant="outline" onClick={() => setUpgradeFlow(null)} className="w-full">Close</Button>
                            </div>
                        )}
                    </DialogContent>
                </Dialog>
        </DashboardLayout>
    )
}
