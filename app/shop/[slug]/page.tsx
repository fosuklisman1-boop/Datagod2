"use client"

import { useEffect, useState, useRef } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { shopService, shopPackageService, shopOrderService, networkLogoService } from "@/lib/shop-service"
import { shopOrigin } from "@/lib/shop-url"
import { supabase } from "@/lib/supabase"
import { useShopSettings } from "@/hooks/use-shop-settings"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { redirectToPayment } from "@/lib/payment-redirect"
import { useResendCooldown } from "@/lib/use-resend-cooldown"
import {
  Store,
  ShoppingCart,
  Package,
  AlertCircle,
  AlignJustify,
  MessageCircle,
  Zap,
  ArrowRight,
  GraduationCap,
  CheckCircle2,
  MapPin,
  Clock,
  Loader2,
  Search,
  Menu,
  X,
  ChevronLeft
} from "lucide-react"
import { AirtimeStorefrontForm } from "@/components/shop/AirtimeStorefrontForm"
import { ResultsCheckerStorefrontForm } from "@/components/shop/ResultsCheckerStorefrontForm"
import { VoucherLookup } from "@/components/shop/VoucherLookup"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { toast } from "sonner"
import { AnnouncementModal } from "@/components/announcement-modal"
import { AIChatWidget } from "@/components/shop/AIChatWidget"

export default function ShopStorefront() {
  const params = useParams()
  const router = useRouter()
  const shopSlug = params.slug as string

  const [shop, setShop] = useState<any>(null)
  const [packages, setPackages] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPackage, setSelectedPackage] = useState<any>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})
  const [activeTab, setActiveTab] = useState<"products" | "airtime" | "vouchers" | "about" | "track-order">("products")
  const [rcTab, setRcTab] = useState<"buy" | "retrieve">("buy")
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [orderData, setOrderData] = useState({
    customer_name: "",
    customer_email: "",
    customer_phone: "",
  })
  const [submitting, setSubmitting] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string>("")
  const [turnstileEnabled, setTurnstileEnabled] = useState<boolean>(true) // default true until status loads
  const [honeypot, setHoneypot] = useState<string>("")
  // Checkout phone-OTP gate (admin-toggleable). When ON, the customer enters a
  // MoMo PAYMENT number, verifies it via OTP, and we charge it directly (no
  // hosted redirect), showing a live "approve the prompt" modal.
  const [otpRequired, setOtpRequired] = useState<boolean>(false)
  // Direct MoMo charge is now an INDEPENDENT toggle from the OTP gate. When ON,
  // we collect payment via the on-page direct charge (momoDirect) instead of the
  // hosted Paystack redirect — regardless of whether OTP is required.
  const [directCharge, setDirectCharge] = useState<boolean>(false)
  const [paymentPhone, setPaymentPhone] = useState("")
  const otpCooldown = useResendCooldown(paymentPhone.replace(/\D/g, ""))
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [otpVerified, setOtpVerified] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  // Live MoMo charge modal
  const [momoModal, setMomoModal] = useState<null | { state: "awaiting" | "success" | "failed"; orderId?: string; summary?: any; message?: string }>(null)
  const [globalOrderingEnabled, setGlobalOrderingEnabled] = useState(true)
  const [termsContent, setTermsContent] = useState("")
  const [termsLastUpdated, setTermsLastUpdated] = useState<string | null>(null)
  const packagesRef = useRef<HTMLDivElement>(null)

  const [showAnnouncement, setShowAnnouncement] = useState(false)
  const [activeAnnouncement, setActiveAnnouncement] = useState<{title: string, message: string} | null>(null)

  const { settings: shopSettings } = useShopSettings(shop?.id)

  useEffect(() => {
    loadShopData()
    loadNetworkLogos()

    // Fetch checkout requirements — Turnstile widget + OTP gate state
    fetch("/api/public/turnstile-status")
      .then(r => r.ok ? r.json() : { enabled: true, otp_required: false, direct_charge: false })
      .then(d => {
        setTurnstileEnabled(d.enabled !== false)  // fail-safe: assume enabled
        setOtpRequired(d.otp_required === true)
        setDirectCharge(d.direct_charge === true)
      })
      .catch(() => { setTurnstileEnabled(true); setOtpRequired(false); setDirectCharge(false) })
  }, [shopSlug])

  useEffect(() => {
    // Scroll to packages when network is selected
    if (selectedNetwork && packagesRef.current) {
      setTimeout(() => {
        packagesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      }, 100)
    }
  }, [selectedNetwork])

  // One-time OTP: if the PAYMENT number was already verified before, auto-skip
  // the OTP step (returning customers don't re-verify every purchase).
  useEffect(() => {
    if (!otpRequired || otpVerified) return
    const phone = paymentPhone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(phone)) return
    const t = setTimeout(() => {
      fetch("/api/public/phone-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone }),
      })
        .then(r => r.ok ? r.json() : { verified: false })
        .then(d => { if (d.verified) setOtpVerified(true) })
        .catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [paymentPhone, otpRequired, otpVerified])

  const loadShopData = async () => {
    try {
      setLoading(true)
      const shopData = await shopService.getShopBySlug(shopSlug)

      if (!shopData) {
        toast.error("Shop not found")
        return
      }

      setShop(shopData)

      // Get available packages using the public-packages API
      // This handles both regular shops and sub-agents
      try {
        const response = await fetch(`/api/shop/public-packages?slug=${shopSlug}`, { cache: "no-store" })
        const data = await response.json()

        if (data.ordering_enabled !== undefined) {
          setGlobalOrderingEnabled(data.ordering_enabled)
        }

        if (data.terms_content) {
          setTermsContent(data.terms_content)
        }
        if (data.terms_last_updated) {
          setTermsLastUpdated(data.terms_last_updated)
        }

        if (data.packages && data.packages.length > 0) {
          setPackages(data.packages)
        } else {
          setPackages([])
        }

        // Handle Announcement Logic
        if (data.announcement) {
          const { title, message } = data.announcement
          
          // Hash the content to know if we've seen *this exact* announcement
          // We add the shopSlug to the hash so different shop announcements don't overlap
          const contentString = `${shopSlug}:${title}:${message}`
          const announcementHash = btoa(unescape(encodeURIComponent(contentString))).substring(0, 16)
          const sessionKey = `storefront_announcement_${announcementHash}`

          const hasSeen = sessionStorage.getItem(sessionKey)

          if (!hasSeen) {
            setActiveAnnouncement({ title, message })
            setShowAnnouncement(true)
            // Save the current hash so we can mark it as seen when closed
            sessionStorage.setItem("current_storefront_announcement", sessionKey)
          }
        }
      } catch (pkgError: any) {
        console.error("Error loading packages:", pkgError)
        setPackages([])
      }
    } catch (error) {
      console.error("Error loading shop:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load shop"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const loadNetworkLogos = async () => {
    try {
      const logos = await networkLogoService.getLogosAsObject()
      setNetworkLogos(logos)
    } catch (error) {
      console.error("Error loading network logos:", error)
      // Fallback to default logos if database fetch fails
    }
  }

  const handleBuyNow = (pkg: any) => {
    setSelectedPackage(pkg)
    setCheckoutOpen(true)
  }

  const getNetworkLogo = (network: string): string => {
    // Try exact match first
    if (networkLogos[network]) {
      return networkLogos[network]
    }

    // Try normalized version (capitalize first letter)
    const normalized = network.charAt(0).toUpperCase() + network.slice(1).toLowerCase()
    if (networkLogos[normalized]) {
      return networkLogos[normalized]
    }

    // Return empty string if not found (will show broken image, forcing database fetch)
    return ""
  }

  const validatePhoneNumberField = (phone: string, network?: string): boolean => {
    const result = validatePhoneNumber(phone, network)
    return result.isValid
  }

  // ── Checkout payment-number OTP (only used when otpRequired) ─────────────
  const handleSendCheckoutOtp = async () => {
    const digits = paymentPhone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(digits)) { toast.error("Enter a valid Mobile Money number first"); return }
    setSendingOtp(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data?.error || "Failed to send code"); return }
      toast.success("Verification code sent to your phone")
      setOtpSent(true)
      otpCooldown.start()
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setSendingOtp(false)
    }
  }

  const handleVerifyCheckoutOtp = async () => {
    if (!otpCode || otpCode.length < 4) { toast.error("Enter the code from your SMS"); return }
    setVerifyingOtp(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone, code: otpCode.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.verified) { toast.error(data?.error || "Incorrect code"); return }
      toast.success("Payment number verified ✓")
      setOtpVerified(true)
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setVerifyingOtp(false)
    }
  }

  // Poll order payment status while the live MoMo prompt modal is open.
  const pollMomoStatus = (orderId: string, summary: any) => {
    const started = Date.now()
    const TIMEOUT_MS = 4 * 60 * 1000 // 4 minutes to approve the prompt
    const tick = async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        setMomoModal({ state: "failed", message: "Payment timed out. If you approved the prompt, your order will still be processed — check your orders, or try again." })
        return
      }
      try {
        const res = await fetch(`/api/payments/momo-status?orderId=${orderId}&orderType=data`)
        const d = await res.json().catch(() => ({ status: "pending" }))
        if (d.status === "completed") { setMomoModal({ state: "success", orderId, summary }); return }
        if (d.status === "failed") { setMomoModal({ state: "failed", message: "Payment was not completed. Please try again." }); return }
      } catch { /* keep polling */ }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 3000)
  }

  const handleSubmitOrder = async () => {
    if (!orderData.customer_name.trim()) {
      toast.error("Please enter your name")
      return
    }

    if (!orderData.customer_email.trim()) {
      toast.error("Please enter your email")
      return
    }

    if (!validatePhoneNumberField(orderData.customer_phone, selectedPackage.network)) {
      toast.error("Please enter a valid phone number")
      return
    }

    try {
      setSubmitting(true)

      console.log("[CHECKOUT] Starting order submission...")

      // Normalize phone number using shared utility
      const phoneResult = validatePhoneNumber(orderData.customer_phone, selectedPackage.network)
      if (!phoneResult.isValid) {
        throw new Error(phoneResult.error || "Invalid phone number")
      }
      const normalizedPhone = phoneResult.normalized

      const pkg = selectedPackage.packages
      const profitAmount = selectedPackage.profit_margin

      // Use selling_price from API if available (for sub-agents), otherwise calculate
      // This ensures we respect the dealer pricing logic used in public-packages API
      const totalPrice = selectedPackage.selling_price !== undefined
        ? selectedPackage.selling_price
        : (pkg.price + profitAmount)

      // Derive base price from total (total = base + profit)
      const basePrice = totalPrice - profitAmount

      // Extract volume as number (e.g., "1GB" -> 1)
      const volumeGb = parseInt(pkg.size.toString().replace(/[^0-9]/g, "")) || 0

      console.log("[CHECKOUT] Creating order with details:", {
        shop_slug: shopSlug,
        customer_name: orderData.customer_name,
        customer_email: orderData.customer_email,
        network: pkg.network,
        totalPrice,
      })

      // Create order via API. We send only shop_slug — the server resolves it to the
      // internal shop_id. Client never needs to know or transmit the UUID.
      const createOrderResponse = await fetch("/api/shop/orders/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer_name: orderData.customer_name,
          customer_email: orderData.customer_email,
          customer_phone: normalizedPhone,
          // The MoMo number we charge on-page (direct charge) and/or OTP-verify.
          paymentPhone: (otpRequired || directCharge) ? paymentPhone : undefined,
          shop_package_id: selectedPackage.id,
          package_id: pkg.id,
          network: pkg.network,
          volume_gb: volumeGb,
          base_price: basePrice,
          profit_amount: profitAmount,
          total_price: totalPrice,
          shop_slug: shopSlug,
          turnstileToken,
          website: honeypot,
        }),
      })

      if (!createOrderResponse.ok) {
        let errorMsg = "Failed to create order"
        try {
          const errorData = await createOrderResponse.json()
          errorMsg = errorData.error || errorMsg
        } catch (e) {
          console.error("[CHECKOUT] Could not parse order creation error:", e)
        }
        console.error("[CHECKOUT] Order creation failed:", errorMsg)
        throw new Error(errorMsg)
      }

      const createOrderData = await createOrderResponse.json()
      const order = createOrderData.order

      console.log("[CHECKOUT] Order created successfully:", order.id)

      // Save order details to localStorage for Safari recovery
      if (typeof window !== "undefined" && window.localStorage) {
        localStorage.setItem('checkout_order_id', order.id)
        localStorage.setItem('checkout_order_data', JSON.stringify({
          shop_slug: shopSlug,
          customer_name: orderData.customer_name,
          customer_email: orderData.customer_email,
          customer_phone: normalizedPhone,
          total_price: totalPrice,
        }))
        console.log("[CHECKOUT] Order data saved to localStorage")
      }

      // ── Direct MoMo charge path (direct-charge toggle ON) ────────────────
      // We charge the on-page Mobile Money number directly via Paystack /charge
      // instead of the hosted redirect, then keep the customer on-page with a live
      // modal that polls order status until charge.success confirms the prompt.
      // When the OTP gate is also on, the number must be verified first (the
      // prompt can then only reach a number the customer proved they control).
      if (directCharge) {
        if (otpRequired && !otpVerified) {
          toast.error("Please verify your Mobile Money number first")
          return
        }
        const { data: { session: momoSession } } = await supabase.auth.getSession()
        const summary = {
          packageLabel: `${pkg.size} • ${pkg.network}`,
          beneficiary: normalizedPhone,
          paymentPhone,
          amount: totalPrice,
        }
        const chargeRes = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: totalPrice,
            email: orderData.customer_email,
            userId: momoSession?.user?.id || null,
            orderId: order.id,
            shopSlug,
            momoDirect: true,
            paymentPhone,
          }),
        })
        const chargeData = await chargeRes.json().catch(() => ({}))
        if (!chargeRes.ok || !chargeData.success) {
          throw new Error(chargeData?.error || "Could not start the Mobile Money charge. Please try again.")
        }
        // Close the checkout dialog and show the live "approve the prompt" modal.
        setCheckoutOpen(false)
        setMomoModal({ state: "awaiting", orderId: order.id, summary })
        pollMomoStatus(order.id, { ...summary, reference: chargeData.reference })
        return
      }

      // Initialize Paystack payment
      toast.info("Redirecting to payment...")
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.user?.id) {
        console.warn("[CHECKOUT] No authenticated user session, proceeding with anonymous payment")
      }

      console.log("[CHECKOUT] Initializing payment with userId:", session?.user?.id)

      try {
        const fetchOptions: RequestInit = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: totalPrice,
            email: orderData.customer_email,
            userId: session?.user?.id || null,
            orderId: order.id,
            shopSlug: shopSlug,
          }),
        }

        console.log("[CHECKOUT] Sending payment request with options:", { method: fetchOptions.method, headers: fetchOptions.headers })

        const paymentResponse = await fetch("/api/payments/initialize", fetchOptions)

        console.log("[CHECKOUT] Payment response status:", paymentResponse.status)
        console.log("[CHECKOUT] Payment response headers:", {
          contentType: paymentResponse.headers.get("content-type"),
          status: paymentResponse.status,
          statusText: paymentResponse.statusText,
        })

        if (!paymentResponse.ok) {
          let errorMsg = "Failed to initialize payment"
          let errorData = null
          try {
            const responseText = await paymentResponse.text()
            console.log("[CHECKOUT] Raw response body:", responseText)
            if (responseText) {
              errorData = JSON.parse(responseText)
              errorMsg = errorData.error || errorMsg
            }
          } catch (parseError) {
            console.error("[CHECKOUT] Could not parse error response:", parseError)
            errorMsg = `HTTP ${paymentResponse.status}: ${paymentResponse.statusText}`
          }
          console.error("[CHECKOUT] Payment API error:", {
            status: paymentResponse.status,
            statusText: paymentResponse.statusText,
            errorMsg,
            errorData,
          })
          throw new Error(errorMsg)
        }

        const paymentData = await paymentResponse.json()

        console.log("[CHECKOUT] Payment initialized:", {
          reference: paymentData.reference,
          hasUrl: !!paymentData.authorizationUrl,
          paymentId: paymentData.paymentId,
        })

        // Redirect to Paystack (handles popup blocker scenarios)
        if (paymentData.authorizationUrl) {
          // Store payment reference in sessionStorage for verification after redirect
          if (typeof window !== "undefined" && window.sessionStorage) {
            sessionStorage.setItem('lastPaymentReference', paymentData.reference || "")
            console.log("[CHECKOUT] Stored payment reference:", paymentData.reference)
          }

          // Store payment URL and reference in localStorage for Safari recovery
          if (typeof window !== "undefined" && window.localStorage) {
            localStorage.setItem('checkout_payment_url', paymentData.authorizationUrl)
            localStorage.setItem('checkout_payment_reference', paymentData.reference || "")
            console.log("[CHECKOUT] Payment URL and reference saved to localStorage")
          }

          // Redirect directly to payment
          console.log("[CHECKOUT] Redirecting to payment URL")
          await redirectToPayment({
            url: paymentData.authorizationUrl,
            delayMs: 100,
            onError: (error: Error) => {
              console.error("[CHECKOUT] Payment redirect failed:", error)
              toast.error("Payment redirect failed. Please try again.")
            }
          })
          return
        } else {
          throw new Error("No authorization URL received from payment provider")
        }
      } catch (paymentError) {
        console.error("[CHECKOUT] Payment initialization error:", paymentError)
        if (paymentError instanceof TypeError && paymentError.message.includes("fetch")) {
          throw new Error("Network error: Unable to connect to payment service. Please check your connection and try again.")
        }
        throw paymentError
      }
    } catch (error) {
      console.error("[CHECKOUT] Order submission error:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to place order. Please try again."
      console.error("[CHECKOUT] Full error details:", {
        message: errorMessage,
        error: error,
        errorStack: error instanceof Error ? error.stack : "N/A",
      })
      toast.error(errorMessage)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCloseAnnouncement = () => {
    setShowAnnouncement(false)
    const sessionKey = sessionStorage.getItem("current_storefront_announcement")
    if (sessionKey) {
      sessionStorage.setItem(sessionKey, "true")
    }
  }

  // Early return while verifying shop
  if (loading) {
    return (
      <div className="min-h-screen bg-card flex items-center justify-center">
        <div className="text-center">
          <img src="/favicon_custom.ico" alt="DATAGOD Logo" className="w-16 h-16 rounded-lg object-cover" />
          <p className="text-muted-foreground">Loading store...</p>
        </div>
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="min-h-screen bg-card p-4">
        <div className="max-w-2xl mx-auto pt-20">
          <Alert className="border-border bg-red-50">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-700">
              Store not found. Please check the URL and try again.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    )
  }

  // Tab navigation items
  const tabs: Array<{ id: "products" | "about" | "track-order", label: string, icon: React.ReactNode }> = [
    { id: "products", label: "Shop Products", icon: <ShoppingCart className="w-4 h-4" /> },
    { id: "track-order", label: "Track Order", icon: <Package className="w-4 h-4" /> },
    { id: "about", label: "About Shop", icon: <AlertCircle className="w-4 h-4" /> },
  ]

  return (
    <div className="min-h-screen bg-card">
      {/* Breadcrumb Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: "1",
                name: "Home",
                item: "https://www.datagod.store",
              },
              {
                "@type": "ListItem",
                position: "2",
                name: "Shop",
                item: "https://www.datagod.store/shop",
              },
              {
                "@type": "ListItem",
                position: "3",
                name: shop?.shop_name || shop?.name || "Shop",
                item: shop?.subdomain ? shopOrigin(shop.subdomain) : `https://www.datagod.store/shop/${shopSlug}`,
              },
            ],
          }),
        }}
      />
      {/* Navigation Bar */}
      <nav className="bg-card border-b border-border shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1">
            {/* 3-Line Hamburger Button */}
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-violet-50 text-foreground hover:text-violet-600 rounded-lg transition-all duration-200 hover:shadow-md"
              aria-label="Toggle navigation menu"
              aria-expanded={sidebarOpen}
            >
              <AlignJustify className="w-6 h-6" />
            </button>

            {/* Shop Info */}
            <div className="flex items-center gap-3">
              <Store className="w-6 h-6 text-violet-600 hidden sm:block" />
              <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">
                {shop.shop_name || shop.name || "Store"}
              </h1>
            </div>
          </div>

          {/* Shop Logo */}
          {shop.logo_url && (
            <img
              src={shop.logo_url}
              alt={shop.shop_name || "Shop"}
              className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover border-2 border-border flex-shrink-0"
            />
          )}
        </div>
      </nav>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-20 transition-opacity duration-200"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Collapsible Sidebar */}
      <aside
        className={`fixed left-0 top-16 h-[calc(100vh-64px)] bg-card border-r border-border w-64 transform transition-all duration-300 ease-in-out z-30 shadow-lg ${sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
      >
        <div className="sticky top-0 overflow-y-auto h-full">
          <Card className="border-0 shadow-none rounded-none h-full">
            <CardContent className="p-4">
              <nav className="space-y-1">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveTab(tab.id)
                      setSidebarOpen(false)
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-medium transition-all duration-200 ${activeTab === tab.id
                      ? "bg-violet-100 text-violet-700 border-l-4 border-l-violet-600 shadow-sm"
                      : "text-foreground hover:bg-accent border-l-4 border-l-transparent"
                      }`}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                  </button>
                ))}
              </nav>
            </CardContent>
          </Card>
        </div>
      </aside>
      {shop.banner_url && (
        <div className="h-40 relative overflow-hidden">
          <img
            src={shop.banner_url}
            alt={shop.shop_name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/30" />
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4">
        {/* Shop Description Section */}
        <div className="py-8 mb-8 text-center px-2">
          <p className="text-muted-foreground break-words text-sm sm:text-base md:text-lg">{shop.description || "Welcome to our store"}</p>
          <div className="flex flex-wrap gap-3 mt-4 justify-center">
            {shopSettings?.whatsapp_link && (
              <a
                href={shopSettings.whatsapp_link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition-colors"
              >
                <MessageCircle className="w-4 h-4" />
                Contact on WhatsApp
              </a>
            )}
          </div>
        </div>

        {/* Global Maintenance Alert */}
        {!globalOrderingEnabled && (
          <Alert className="mb-8 border-red-500 bg-red-50 shadow-md">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-700 font-bold flex items-center gap-2">
              <span className="animate-pulse">●</span>
              Order placement is currently paused for maintenance. Please check back later.
            </AlertDescription>
          </Alert>
        )}

        {/* Main Content Layout */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {/* Products Tab (Data, Airtime & Vouchers) */}
            {(activeTab === "products" || activeTab === "airtime" || activeTab === "vouchers") && (
              <div className="space-y-8">
                {/* Sub-tab Switcher */}
                <div className="flex p-1.5 bg-muted rounded-2xl w-full sm:w-fit mx-auto sm:mx-0 shadow-inner">
                  <button
                    onClick={() => setActiveTab("products")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "products"
                        ? "bg-card text-violet-700 shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <ShoppingCart className="w-5 h-5" />
                    Buy Data
                  </button>
                  <button
                    onClick={() => setActiveTab("airtime")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "airtime"
                        ? "bg-card text-violet-700 shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <Zap className="w-5 h-5" />
                    Buy Airtime
                  </button>
                  <button
                    onClick={() => setActiveTab("vouchers")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "vouchers"
                        ? "bg-card text-violet-700 shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <GraduationCap className="w-5 h-5" />
                    Results Vouchers
                  </button>
                </div>

                {activeTab === "products" ? (
                  /* Data Packages Section */
                  <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div>
                      <h2 className="text-2xl font-black mb-6 text-foreground border-l-4 border-violet-600 pl-4">Fast Data Packages</h2>

                      {packages.length === 0 ? (
                        <Card className="bg-card/50 border-2 border-dashed border-border backdrop-blur-sm">
                          <CardContent className="pt-12 pb-12 text-center">
                            <Store className="w-12 h-12 mx-auto text-gray-300 mb-3" />
                            <p className="text-muted-foreground font-medium">No packages available at the moment</p>
                          </CardContent>
                        </Card>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
                            {Array.from(new Set(packages.map(p => p.packages.network))).map((network) => {
                              const networkPackages = packages.filter(p => p.packages.network === network)
                              const availableCount = networkPackages.filter(p => p.is_available).length

                              return (
                                <Card
                                  key={network}
                                  onClick={() => setSelectedNetwork(network as string)}
                                  className={`group cursor-pointer hover:shadow-2xl transition-all duration-500 hover:-translate-y-2 overflow-hidden border-0 ${selectedNetwork === network
                                      ? "ring-4 ring-violet-600 shadow-xl"
                                      : "shadow-md bg-card/80"
                                    }`}
                                >
                                  <div className="flex flex-col h-full relative">
                                    <div className={`h-24 sm:h-32 w-full flex items-center justify-center relative overflow-hidden transition-colors ${selectedNetwork === network ? 'bg-violet-50' : 'bg-muted/40 group-hover:bg-muted'}`}>
                                      <img
                                        src={getNetworkLogo(network as string)}
                                        alt={network}
                                        className={`h-16 w-16 sm:h-20 sm:w-20 object-contain transition-transform duration-500 ${selectedNetwork === network ? 'scale-110' : 'group-hover:scale-110'}`}
                                      />
                                    </div>

                                    <div className="flex-1 p-3 text-center">
                                      <h3 className={`text-sm sm:text-base font-black uppercase tracking-tight ${selectedNetwork === network ? 'text-violet-700' : 'text-foreground'}`}>{network}</h3>
                                      <p className="text-[10px] sm:text-xs text-muted-foreground font-bold mt-1 uppercase opacity-60">{availableCount} plans</p>
                                    </div>
                                    
                                    {selectedNetwork === network && (
                                      <div className="absolute top-2 right-2 bg-violet-600 text-white rounded-full p-1 shadow-lg">
                                        <CheckCircle2 className="w-3 h-3 sm:w-4 sm:h-4" />
                                      </div>
                                    )}
                                  </div>
                                </Card>
                              )
                            })}
                          </div>

                          {/* Packages Grid */}
                          {selectedNetwork && (
                            <div ref={packagesRef} className="py-10 border-t border-border animate-in fade-in slide-in-from-bottom-8 duration-700">
                              <div className="flex items-center gap-4 mb-8">
                                <div className="p-3 bg-violet-100 rounded-2xl">
                                  <img src={getNetworkLogo(selectedNetwork)} className="w-8 h-8 object-contain" alt={selectedNetwork} />
                                </div>
                                <div>
                                  <h2 className="text-2xl font-black text-foreground uppercase tracking-tight">{selectedNetwork} Offers</h2>
                                  <p className="text-sm font-medium text-muted-foreground">Pick the perfect plan for your needs</p>
                                </div>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                                {packages
                                  .filter(p => p.packages.network === selectedNetwork)
                                  .sort((a, b) => {
                                    const toMb = (s: string) => {
                                      const m = s.trim().match(/(\d+(?:\.\d+)?)\s*(MB|GB|TB)/i)
                                      if (!m) { const n = parseFloat(s); return isNaN(n) ? 0 : n * 1024 }
                                      const v = parseFloat(m[1])
                                      if (m[2].toUpperCase() === 'MB') return v
                                      if (m[2].toUpperCase() === 'TB') return v * 1024 * 1024
                                      return v * 1024
                                    }
                                    return toMb(a.packages.size) - toMb(b.packages.size)
                                  })
                                  .map((shopPkg) => {
                                    const pkg = shopPkg.packages
                                    const totalPrice = pkg.price + shopPkg.profit_margin

                                    return (
                                      <Card key={shopPkg.id} className="group hover:shadow-2xl transition-all duration-500 hover:-translate-y-2 border-0 shadow-lg bg-card overflow-hidden rounded-2xl">
                                        <div className="h-2 bg-gradient-to-r from-violet-600 to-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                                        <CardHeader className="pb-2">
                                          <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                              <CardTitle className="text-2xl font-black text-foreground group-hover:text-violet-700 transition-colors">
                                                {pkg.size}GB
                                              </CardTitle>
                                              <CardDescription className="text-sm font-medium text-muted-foreground mt-1">{pkg.description}</CardDescription>
                                            </div>
                                            <Badge className={shopPkg.is_available ? "bg-green-100 text-green-700 border-border" : "bg-red-100 text-red-700 border-border"}>
                                              {shopPkg.is_available ? "Active" : "OOS"}
                                            </Badge>
                                          </div>
                                        </CardHeader>
                                        <CardContent className="space-y-6 pt-0">
                                          <div className="flex justify-between items-end pt-4">
                                            <div className="flex flex-col">
                                              <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Price</span>
                                              <span className="text-3xl font-black text-foreground">
                                                GHS {totalPrice.toFixed(2)}
                                              </span>
                                            </div>
                                            <div className="flex flex-col items-end">
                                              <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest mb-1">Status</span>
                                              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-violet-50 text-violet-700 rounded-lg text-xs font-bold ring-1 ring-violet-200/50">
                                                <Zap className="w-3 h-3 fill-violet-700" />
                                                Instant
                                              </div>
                                            </div>
                                          </div>

                                          <Button
                                            onClick={() => handleBuyNow(shopPkg)}
                                            disabled={!shopPkg.is_available || !globalOrderingEnabled}
                                            className="w-full h-14 bg-slate-900 hover:bg-violet-700 text-white font-black rounded-xl shadow-xl transition-all duration-300 disabled:opacity-50 group-hover:scale-[1.02]"
                                          >
                                            <ShoppingCart className="w-5 h-5 mr-3" />
                                            Order Now
                                          </Button>
                                        </CardContent>
                                      </Card>
                                    )
                                  })}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ) : activeTab === "airtime" ? (
                  /* Airtime Form Section */
                  <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <AirtimeStorefrontForm shop={shop} shopSlug={shopSlug} />
                  </div>
                ) : (
                  /* Results Checker Vouchers Section */
                  <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">
                    {/* RC sub-tab: Buy / Retrieve */}
                    <div className="flex p-1 bg-muted rounded-xl w-full sm:w-fit shadow-inner">
                      <button
                        onClick={() => setRcTab("buy")}
                        className={`flex-1 sm:flex-none px-5 py-2 rounded-lg font-semibold text-sm transition-all duration-200 ${rcTab === "buy" ? "bg-card text-violet-700 shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Buy Vouchers
                      </button>
                      <button
                        onClick={() => setRcTab("retrieve")}
                        className={`flex-1 sm:flex-none px-5 py-2 rounded-lg font-semibold text-sm transition-all duration-200 ${rcTab === "retrieve" ? "bg-card text-violet-700 shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Retrieve Vouchers
                      </button>
                    </div>
                    {rcTab === "buy"
                      ? <ResultsCheckerStorefrontForm shop={shop} shopSlug={shopSlug} />
                      : <VoucherLookup />
                    }
                  </div>
                )}
              </div>
            )}

            {/* About Tab */}
            {activeTab === "about" && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <Card className="border-0 shadow-md">
                  <CardHeader className="pb-3">
                    <CardTitle>Shop Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {shop.phone && (
                      <div className="flex items-start gap-2">
                        <MessageCircle className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-semibold text-foreground">Phone</p>
                          <span className="text-foreground">{shop.phone}</span>
                        </div>
                      </div>
                    )}
                    {shop.location && (
                      <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-semibold text-foreground">Location</p>
                          <span className="text-foreground">{shop.location}</span>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start gap-2 pt-2 border-t">
                      <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-foreground">Support</p>
                        <p className="text-foreground">24/7 Support Available</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Platform Terms of Service */}
                <ShopTermsSection termsContent={termsContent} termsLastUpdated={termsLastUpdated} />
              </div>
            )}

            {/* Track Order Tab */}
            {activeTab === "track-order" && (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Package className="w-5 h-5" />
                      Track Your Order
                    </CardTitle>
                    <CardDescription>Enter your phone number to check order status</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <OrderStatusSearch shopId={shop?.id} shopName={shop?.shop_name} />
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>
      {
        checkoutOpen && selectedPackage && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <Card className="w-full max-w-md bg-card max-h-[90vh] flex flex-col">
              <CardHeader className="border-b border-border shrink-0">
                <CardTitle>Checkout</CardTitle>
                <CardDescription>
                  {selectedPackage.packages.network} - {selectedPackage.packages.size}GB
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6 space-y-4 overflow-y-auto flex-1 min-h-0">
                <div>
                  <Label>Full Name *</Label>
                  <Input
                    value={orderData.customer_name}
                    onChange={(e) => setOrderData({ ...orderData, customer_name: e.target.value })}
                    placeholder="John Doe"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label>Email Address *</Label>
                  <Input
                    type="email"
                    value={orderData.customer_email}
                    onChange={(e) => setOrderData({ ...orderData, customer_email: e.target.value })}
                    placeholder="john@example.com"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label>Phone Number (MTN, Telecel, AT) *</Label>
                  <Input
                    value={orderData.customer_phone}
                    onChange={(e) => {
                      setOrderData({ ...orderData, customer_phone: e.target.value })
                      // changing phone invalidates any prior OTP verification
                      if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode("") }
                    }}
                    placeholder="0201234567 or 0551234567"
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Format: 10 digits starting with 02 or 05 (e.g., 0201234567)
                  </p>
                </div>

                {/* Order Summary */}
                <div className="p-4 bg-card rounded-lg border border-border">
                  <div className="flex justify-between items-end mb-3">
                    <span className="font-semibold text-foreground">Total Amount:</span>
                    <span className="text-2xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                      GHS {(selectedPackage.selling_price !== undefined ? selectedPackage.selling_price : (selectedPackage.packages.price + selectedPackage.profit_margin)).toFixed(2)}
                    </span>
                  </div>
                </div>

                <Alert className="border-border bg-primary/5">
                  <AlertCircle className="h-4 w-4 text-primary" />
                  <AlertDescription className="text-xs text-primary">
                    {directCharge
                      ? "A Mobile Money prompt will be sent to the number you enter below. Approve it with your PIN to complete the order."
                      : "You will be redirected to Paystack to complete your payment."}
                  </AlertDescription>
                </Alert>

                <HoneypotField value={honeypot} onChange={setHoneypot} />

                {/* Payment-number step. Shown whenever OTP verification OR direct
                    charge is on — both need the on-page MoMo number. The OTP
                    send/verify controls render only when OTP is required; with
                    direct charge alone the number is simply charged as typed. */}
                {(otpRequired || directCharge) && (
                  <div className="p-4 rounded-lg bg-purple-50 border border-border space-y-3">
                    <div>
                      <Label className="text-sm font-semibold text-purple-900">Mobile Money number to pay from *</Label>
                      <Input
                        value={paymentPhone}
                        onChange={(e) => {
                          setPaymentPhone(e.target.value)
                          // changing the number invalidates any prior verification
                          if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode(""); otpCooldown.reset() }
                        }}
                        placeholder="0241234567"
                        className="mt-1 bg-card"
                        disabled={otpRequired && otpVerified}
                      />
                      <p className="text-xs text-purple-700 mt-1">
                        {otpRequired
                          ? "The payment prompt is sent to this number. You verify it once."
                          : "The payment prompt is sent to this number."}
                      </p>
                    </div>

                    {otpRequired && (!otpVerified ? (
                      !otpSent ? (
                        <Button
                          type="button"
                          onClick={handleSendCheckoutOtp}
                          disabled={sendingOtp || otpCooldown.seconds > 0}
                          className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                        >
                          {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                        </Button>
                      ) : (
                        <div className="space-y-2">
                          <Input
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="Enter 6-digit code"
                            value={otpCode}
                            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                            className="text-center text-lg tracking-[0.4em] font-mono bg-card"
                          />
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              onClick={handleVerifyCheckoutOtp}
                              disabled={verifyingOtp || otpCode.length < 4}
                              className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
                            >
                              {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                            </Button>
                            <Button type="button" variant="outline" onClick={handleSendCheckoutOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>
                              {otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                        </div>
                      )
                    ) : (
                      <div className="p-3 rounded-lg bg-green-50 border border-border flex items-center gap-2">
                        <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        <span className="text-sm font-medium text-green-900">Payment number verified ✓</span>
                      </div>
                    ))}
                  </div>
                )}

              </CardContent>

              {/* Fixed action footer — stays visible while the form above scrolls */}
              <div className="border-t border-border p-4 space-y-3 shrink-0">
                {turnstileEnabled && (
                  <div className="flex justify-center">
                    <TurnstileWidget onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    onClick={handleSubmitOrder}
                    disabled={submitting || (turnstileEnabled && !turnstileToken) || (otpRequired && !otpVerified) || (directCharge && !otpRequired && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, "")))}
                    className="flex-1 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        Place Order
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </>
                    )}
                  </Button>
                  <Button
                    onClick={() => {
                      setCheckoutOpen(false)
                      setOrderData({ customer_name: "", customer_email: "", customer_phone: "" })
                    }}
                    variant="outline"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )
      }

      {/* Live Mobile Money prompt modal (direct-charge flow). Stays on-page while
          the customer approves the prompt; polls order status until the webhook
          flips it to completed, then shows the order summary. */}
      {momoModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-md bg-card">
            {momoModal.state === "awaiting" && (
              <CardContent className="pt-8 pb-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-purple-600 animate-spin" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Approve the prompt on your phone</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    We sent a Mobile Money prompt to{" "}
                    <span className="font-semibold">{momoModal.summary?.paymentPhone}</span>. Enter your PIN to approve the payment of{" "}
                    <span className="font-semibold">GHS {Number(momoModal.summary?.amount || 0).toFixed(2)}</span>.
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> Waiting for confirmation…
                </div>
                <p className="text-xs text-muted-foreground">Keep this page open. This can take up to a minute.</p>
              </CardContent>
            )}

            {momoModal.state === "success" && (
              <CardContent className="pt-8 pb-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                  <svg className="w-9 h-9 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Payment successful 🎉</h3>
                  <p className="text-sm text-muted-foreground mt-1">Your order is confirmed and is being processed.</p>
                </div>
                <div className="text-left p-4 rounded-lg bg-muted/40 border border-border space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Package</span><span className="font-medium">{momoModal.summary?.packageLabel}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Beneficiary</span><span className="font-medium">{momoModal.summary?.beneficiary}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Paid from</span><span className="font-medium">{momoModal.summary?.paymentPhone}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold">GHS {Number(momoModal.summary?.amount || 0).toFixed(2)}</span></div>
                  {momoModal.summary?.reference && (
                    <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span className="font-mono text-xs">{momoModal.summary.reference}</span></div>
                  )}
                </div>
                <Button
                  onClick={() => {
                    setMomoModal(null)
                    setSelectedPackage(null)
                    setOrderData({ customer_name: "", customer_email: "", customer_phone: "" })
                    setPaymentPhone(""); setOtpSent(false); setOtpVerified(false); setOtpCode("")
                  }}
                  className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700"
                >
                  Done
                </Button>
              </CardContent>
            )}

            {momoModal.state === "failed" && (
              <CardContent className="pt-8 pb-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
                  <AlertCircle className="w-9 h-9 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Payment not completed</h3>
                  <p className="text-sm text-muted-foreground mt-1">{momoModal.message || "The prompt was not approved. Please try again."}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setMomoModal(null)} className="flex-1">Close</Button>
                  <Button onClick={() => { setMomoModal(null); setCheckoutOpen(true) }} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white">Try again</Button>
                </div>
              </CardContent>
            )}
          </Card>
        </div>
      )}

      {/* Floating WhatsApp Icon */}
      {
        shopSettings?.whatsapp_link && (
          <a
            href={shopSettings.whatsapp_link}
            target="_blank"
            rel="noopener noreferrer"
            className="fixed bottom-24 right-6 p-4 bg-green-500 hover:bg-green-600 text-white rounded-full shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110 z-50 flex items-center justify-center"
            title="Contact on WhatsApp"
          >
            <MessageCircle className="w-6 h-6" />
          </a>
        )
      }

      {/* Announcement Modal */}
      <AnnouncementModal
        isOpen={showAnnouncement}
        onClose={handleCloseAnnouncement}
        title={activeAnnouncement?.title || ""}
        message={activeAnnouncement?.message || ""}
      />

      {shop && (
        <AIChatWidget
          shop={{ shop_name: shop.shop_name }}
          shopSlug={shopSlug}
          onCheckoutPrefill={(pkg) => {
            const match = packages.find(
              (p: any) => p.id === pkg.shop_package_id || p.package_id === pkg.shop_package_id
            )
            if (match) {
              setSelectedPackage(match)
              setCheckoutOpen(true)
            }
          }}
        />
      )}
    </div >
  )
}

function ShopTermsSection({ termsContent, termsLastUpdated }: { termsContent: string; termsLastUpdated: string | null }) {
  const [expanded, setExpanded] = useState(false)

  if (!termsContent) return null

  const lines = termsContent.split("\n")
  let intro = ""
  const sections: Array<{ title: string; body: string }> = []
  let current: { title: string; lines: string[] } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^\d+\.\s/.test(trimmed)) {
      if (current) sections.push({ title: current.title, body: current.lines.join(" ").trim() })
      current = { title: trimmed, lines: [] }
    } else if (current) {
      current.lines.push(trimmed)
    } else {
      intro += (intro ? " " : "") + trimmed
    }
  }
  if (current) sections.push({ title: current.title, body: current.lines.join(" ").trim() })

  const formattedDate = termsLastUpdated
    ? new Date(termsLastUpdated).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : "April 2026"

  return (
    <Card className="border-0 shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlignJustify className="w-4 h-4 text-violet-600" />
            Platform Terms of Service
          </CardTitle>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-violet-600 hover:text-violet-700 font-medium border border-border hover:border-violet-400 rounded px-2 py-0.5 transition-colors"
          >
            {expanded ? "Hide" : "Read Terms"}
          </button>
        </div>
        {intro && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{intro}</p>}
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-3 pt-0">
          {sections.map((s, i) => (
            <div key={i} className="p-3 bg-muted/40 rounded-lg border border-border">
              <p className="text-xs font-bold text-violet-700 mb-1">{s.title}</p>
              <p className="text-xs text-foreground leading-relaxed">{s.body}</p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground pt-1">Last updated: {formattedDate}</p>
        </CardContent>
      )}
    </Card>
  )
}

function OrderStatusSearch({ shopId, shopName }: { shopId: string; shopName: string }) {
  const [phoneNumber, setPhoneNumber] = useState("")
  const [orders, setOrders] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validatePhoneNumber = (phone: string): boolean => {
    const cleaned = phone.replace(/\D/g, "")
    let normalized = cleaned

    if (cleaned.length === 9) {
      normalized = "0" + cleaned
    }

    if (normalized.length !== 10 || !normalized.startsWith("0")) {
      return false
    }

    // Check for valid Ghanaian networks: 02x or 05x
    const secondDigit = normalized[1]
    return ["2", "5"].includes(secondDigit)
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!phoneNumber.trim()) {
      toast.error("Please enter a phone number")
      return
    }

    if (!validatePhoneNumber(phoneNumber)) {
      toast.error("Please enter a valid phone number (02x or 05x for MTN, AT, Telecel)")
      return
    }

    try {
      setSearching(true)
      setError(null)
      setOrders([])

      const cleaned = phoneNumber.replace(/\D/g, "")
      const normalizedPhone = cleaned.length === 9 ? "0" + cleaned : cleaned

      const response = await fetch("/api/shop/orders/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: normalizedPhone,
          shopId: shopId
        })
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to search orders")
      }

      const data = await response.json()
      setOrders(data.orders || [])
      setSearched(true)

      if (data.count === 0) {
        toast.info("No orders found for this phone number")
      } else {
        toast.success(`Found ${data.count} order(s)`)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to search orders"
      setError(errorMessage)
      toast.error(errorMessage)
      console.error("Error searching orders:", err)
    } finally {
      setSearching(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case "completed":
        return "bg-green-100 text-green-800 border-border"
      case "processing":
        return "bg-primary/10 text-primary border-primary/20"
      case "pending":
        return "bg-yellow-100 text-yellow-800 border-border"
      case "failed":
      case "cancelled":
        return "bg-red-100 text-red-800 border-border"
      default:
        return "bg-muted text-foreground border-border"
    }
  }

  return (
    <div className="space-y-6">
      {/* Search Form */}
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSearch} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <div className="flex gap-2">
                <Input
                  id="phone"
                  placeholder="Enter phone number (e.g., 0201234567)"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  disabled={searching}
                  className="flex-1"
                />
                <Button
                  type="submit"
                  disabled={searching}
                  className="gap-2"
                >
                  {searching ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Searching...
                    </>
                  ) : (
                    <>
                      <Search className="w-4 h-4" />
                      Search
                    </>
                  )}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Results */}
      {searched && (
        <>
          {orders.length === 0 ? (
            <Card>
              <CardContent className="pt-8 pb-8">
                <div className="text-center space-y-4">
                  <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto" />
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">No orders found</h3>
                    <p className="text-muted-foreground">
                      We couldn't find any orders with phone number: <span className="font-mono font-semibold">{phoneNumber}</span>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base sm:text-lg font-bold text-foreground">
                  Found {orders.length} Order{orders.length !== 1 ? "s" : ""}
                </h3>
                <Badge variant="outline">{orders.length}</Badge>
              </div>

              {orders.map((order) => (
                <Card key={order.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <Package className="w-4 h-4 text-primary" />
                          <CardTitle className="text-base">{order.network} {order.type === 'airtime' ? 'Airtime' : 'Data'}</CardTitle>
                          <Badge className="text-xs" variant="outline">
                            {order.type === 'airtime' ? `GHS ${order.volume_gb}` : `${order.volume_gb}GB`}
                          </Badge>
                        </div>
                        <CardDescription className="text-xs">
                          Order ID: <span className="font-mono">{order.reference_code}</span>
                        </CardDescription>
                      </div>
                      <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold border ${getStatusColor(order.order_status)}`}>
                        {order.order_status?.charAt(0).toUpperCase() + order.order_status?.slice(1)}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-4 gap-4">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Total</p>
                        <p className="font-semibold text-foreground">₵ {order.total_price.toFixed(2)}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Customer</p>
                        <p className="font-semibold text-foreground">{order.customer_name}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Date</p>
                        <p className="text-sm text-foreground">{new Date(order.created_at).toLocaleDateString()}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Time</p>
                        <p className="text-sm text-foreground">{new Date(order.created_at).toLocaleTimeString()}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Order Status</p>
                        <Badge className={`text-xs border ${getStatusColor(order.order_status)}`}>
                          {order.order_status?.charAt(0).toUpperCase() + order.order_status?.slice(1)}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Payment Status</p>
                        <Badge className={`text-xs border ${getStatusColor(order.payment_status)}`}>
                          {order.payment_status?.charAt(0).toUpperCase() + order.payment_status?.slice(1)}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
