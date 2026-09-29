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
import { generateProductSchema } from "@/lib/structured-data"
import { supabase } from "@/lib/supabase"
import { useShopSettings } from "@/hooks/use-shop-settings"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "@/lib/phone-format"
import { normalizeWhatsAppLink } from "@/lib/whatsapp-link"
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
  ChevronLeft,
  IdCard,
  Users2,
  ShieldCheck,
  AlertTriangle,
  List,
  LayoutGrid,
  ChevronDown,
  ChevronUp,
  Smartphone,
  Phone
} from "lucide-react"
import { AirtimeStorefrontForm } from "@/components/shop/AirtimeStorefrontForm"
import { ResultsCheckerStorefrontForm } from "@/components/shop/ResultsCheckerStorefrontForm"
import { ResultsCheckServiceForm } from "@/components/shop/ResultsCheckServiceForm"
import { VoucherLookup } from "@/components/shop/VoucherLookup"
import { SubAgentRequestForm } from "@/components/shop/SubAgentRequestForm"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { toast } from "sonner"
import { AnnouncementModal } from "@/components/announcement-modal"
import { AIChatWidget } from "@/components/shop/AIChatWidget"
import { SectionDivider } from "@/components/shop/section-divider"

// Real public brand colors for the 3 Ghana MoMo providers -- used to tint the
// checkout sheet by the package's data network, not the shop's own branding.
const NETWORK_BRAND_COLOR: Record<string, string> = {
  MTN: "#FFCC00",
  Telecel: "#E4002B",
  "AT - iShare": "#0066CC",
  "AT - BigTime": "#0066CC",
}
function networkColorFor(network: string | undefined): string {
  return NETWORK_BRAND_COLOR[network || ""] || "#1b388b"
}

// Mirrors lib/paystack.ts's MOMO_PREFIX exactly -- used client-side purely to
// auto-select/confirm which MoMo provider pill matches the typed number. The
// server (app/api/payments/initialize) re-derives the real provider from the
// phone itself; this is a confirmation aid, never an override sent to it.
const MOMO_PREFIX_CLIENT: Record<string, "mtn" | "vod" | "tgo"> = {
  "024": "mtn", "025": "mtn", "053": "mtn", "054": "mtn", "055": "mtn", "059": "mtn",
  "020": "vod", "050": "vod",
  "026": "tgo", "027": "tgo", "056": "tgo", "057": "tgo",
}
function detectMomoProviderClient(phone: string): "mtn" | "vod" | "tgo" | null {
  const d = (phone || "").replace(/\D/g, "")
  const local = d.startsWith("233") ? "0" + d.slice(3) : d.startsWith("0") ? d : "0" + d
  return MOMO_PREFIX_CLIENT[local.slice(0, 3)] ?? null
}
const MOMO_NETWORK_LABEL: Record<"mtn" | "vod" | "tgo", string> = { mtn: "MTN", vod: "Telecel", tgo: "AirtelTigo" }

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
  const [activeTab, setActiveTab] = useState<"home" | "products" | "airtime" | "vouchers" | "about" | "track-order">("home")
  const [rcTab, setRcTab] = useState<"buy" | "retrieve" | "check">("buy")
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [orderData, setOrderData] = useState({
    customer_name: "",
    customer_email: "",
    customer_phone: "",
  })
  const [submitting, setSubmitting] = useState(false)
  const [verifyWarningOpen, setVerifyWarningOpen] = useState(false)
  const [pendingNormalizedPhone, setPendingNormalizedPhone] = useState<string | null>(null)
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
  // Default on: most buyers pay with the same number they're buying for.
  const [sameAsMomo, setSameAsMomo] = useState(true)
  // User's explicit MoMo-provider pill choice; null = just follow auto-detection.
  const [momoNetworkChoice, setMomoNetworkChoice] = useState<"mtn" | "vod" | "tgo" | null>(null)
  const otpCooldown = useResendCooldown(paymentPhone.replace(/\D/g, ""))
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [otpVerified, setOtpVerified] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  // Live MoMo charge modal
  const [momoModal, setMomoModal] = useState<null | { state: "awaiting" | "otp" | "success" | "failed"; orderId?: string; summary?: any; message?: string; reference?: string }>(null)
  const [momoOtpInput, setMomoOtpInput] = useState("")
  const [momoOtpSubmitting, setMomoOtpSubmitting] = useState(false)
  const [globalOrderingEnabled, setGlobalOrderingEnabled] = useState(true)
  // USSD storefront card — admin-gated (storefront_show_ussd_card) AND only
  // rendered once this shop's own USSD PIN is confirmed active+funded.
  const [showUssdCard, setShowUssdCard] = useState(false)
  const [ussdDialCode, setUssdDialCode] = useState<string | null>(null)
  const [shopUssdCode, setShopUssdCode] = useState<string | null>(null)
  const [termsContent, setTermsContent] = useState("")
  const [termsLastUpdated, setTermsLastUpdated] = useState<string | null>(null)
  const packagesRef = useRef<HTMLDivElement>(null)

  // Standalone "check your MTN number" widget — reuses the same real, already-
  // wired /api/verify-phone-live endpoint the checkout flow calls automatically
  // (app/api/verify-phone-live/route.ts -> checkCustomerFacingVerification()).
  // That check returns ONE combined verified/not-verified result across
  // whichever providers admin has configured -- there's no per-"server"
  // breakdown to show, so this only ever reports a single yes/no.
  const [mtnCheckExpanded, setMtnCheckExpanded] = useState(false)
  const [mtnCheckPhone, setMtnCheckPhone] = useState("")
  const [mtnCheckStatus, setMtnCheckStatus] = useState<"idle" | "checking" | "verified" | "unverified" | "error">("idle")

  // Package search + view mode — client-side over the already-fetched
  // `packages` list, no new endpoint needed.
  const [packageSearch, setPackageSearch] = useState("")
  const [packageViewMode, setPackageViewMode] = useState<"grid" | "list">("grid")

  const handleCheckMtnNumber = async () => {
    const digits = mtnCheckPhone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(digits)) {
      setMtnCheckStatus("error")
      return
    }
    setMtnCheckStatus("checking")
    try {
      const res = await fetch("/api/verify-phone-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: [mtnCheckPhone] }),
      })
      const data = await res.json().catch(() => ({}))
      const result = data?.results?.[0]
      setMtnCheckStatus(result?.verified ? "verified" : "unverified")
    } catch {
      setMtnCheckStatus("error")
    }
  }

  const [showAnnouncement, setShowAnnouncement] = useState(false)
  const [activeAnnouncement, setActiveAnnouncement] = useState<{title: string, message: string} | null>(null)

  // Live network->prefix map (admin-editable) for order-time hints/validation;
  // falls back to the hardcoded default if the fetch fails.
  const [prefixMap, setPrefixMap] = useState<NetworkPrefixMap>(DEFAULT_NETWORK_PREFIXES)

  // Pass the slug — getShopBySlug no longer exposes the internal shop id;
  // the settings API resolves slug/subdomain server-side.
  const { settings: shopSettings } = useShopSettings(shop ? shopSlug : undefined)

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

    // USSD card: admin toggle (platform-wide) + this shop's own active PIN
    // (per-shop, only exposed by the API when genuinely usable right now).
    fetch("/api/public/config")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.app_settings?.storefront_show_ussd_card === true) {
          setShowUssdCard(true)
          setUssdDialCode(d.app_settings.ussd_shop_dial_code || null)
        }
      })
      .catch(() => {})
    fetch(`/api/public/shop-ussd-code?shopSlug=${encodeURIComponent(shopSlug)}`)
      .then(r => r.ok ? r.json() : { active: false, code: null })
      .then(d => setShopUssdCode(d.active ? d.code : null))
      .catch(() => {})
  }, [shopSlug])

  useEffect(() => {
    fetch("/api/network-prefixes")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.map) setPrefixMap(d.map) })
      .catch(() => {}) // fall back to defaults silently
  }, [])

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

  // "Use this number for Mobile Money payment" — mirrors the beneficiary
  // number into the payment number while checked; unchecking lets the buyer
  // type a different payer number.
  useEffect(() => {
    if (!sameAsMomo) return
    if (paymentPhone === orderData.customer_phone) return
    setPaymentPhone(orderData.customer_phone)
    if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode("") }
  }, [sameAsMomo, orderData.customer_phone])

  const loadShopData = async () => {
    try {
      setLoading(true)
      const shopData = await shopService.getShopBySlug(shopSlug)

      if (!shopData) {
        // The slug may be a rotated/old handle. Resolve it to the shop's current
        // slug and redirect so old customer links keep working instead of 404ing.
        try {
          const aliasRes = await fetch(`/api/shop/resolve-alias?slug=${encodeURIComponent(shopSlug)}`, { cache: "no-store" })
          if (aliasRes.ok) {
            const { currentSlug } = await aliasRes.json()
            if (currentSlug && currentSlug !== shopSlug) {
              router.replace(`/shop/${currentSlug}`)
              return
            }
          }
        } catch {
          /* fall through to the normal not-found message */
        }
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
    setSameAsMomo(true)
    setMomoNetworkChoice(null)
    setPaymentPhone("")
    setOtpSent(false)
    setOtpVerified(false)
    setOtpCode("")
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

  const validatePhoneNumberField = (phone: string, network?: string, map?: NetworkPrefixMap): boolean => {
    const result = validatePhoneNumber(phone, network, map)
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

  // Submit the OTP Paystack sent for a Telecel Cash direct charge. Success only
  // means the code was accepted — the payment itself still completes via the
  // charge.success webhook, which pollMomoStatus (already running) picks up.
  const submitMomoOtp = async () => {
    if (!momoModal || momoModal.state !== "otp" || !momoOtpInput.trim()) return
    setMomoOtpSubmitting(true)
    try {
      const res = await fetch("/api/payments/submit-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: momoModal.reference, otp: momoOtpInput.trim(), orderId: momoModal.orderId, orderType: "data" }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        toast.error(data.error || "That code was rejected. Please try again.")
        setMomoOtpSubmitting(false)
        return
      }
      setMomoModal({ state: "awaiting", orderId: momoModal.orderId, summary: momoModal.summary, reference: momoModal.reference })
      setMomoOtpInput("")
      setMomoOtpSubmitting(false)
    } catch {
      toast.error("Could not submit the code. Please try again.")
      setMomoOtpSubmitting(false)
    }
  }

  const proceedWithOrderCreation = async (normalizedPhone: string) => {
    try {
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
        // Close the checkout dialog and show the live payment modal. Telecel Cash
        // charges come back "send_otp" (needs a typed code); MTN/AirtelTigo use a
        // push-to-approve prompt instead ("pay_offline"/"pending").
        setCheckoutOpen(false)
        if (chargeData.status === "send_otp") {
          setMomoModal({ state: "otp", orderId: order.id, summary, reference: chargeData.reference })
        } else {
          setMomoModal({ state: "awaiting", orderId: order.id, summary, reference: chargeData.reference })
        }
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

  const handleSubmitOrder = async () => {
    if (!orderData.customer_name.trim()) {
      toast.error("Please enter your name")
      return
    }

    // Email stays optional here (the server synthesizes a guest email from
    // the phone number when left blank -- see app/api/shop/orders/create/route.ts).
    if (!validatePhoneNumberField(orderData.customer_phone, selectedPackage.packages.network, prefixMap)) {
      toast.error("Please enter a valid phone number")
      return
    }

    setSubmitting(true)
    console.log("[CHECKOUT] Starting order submission...")

    // Normalize phone number using shared utility
    const phoneResult = validatePhoneNumber(orderData.customer_phone, selectedPackage.packages.network, prefixMap)
    if (!phoneResult.isValid) {
      toast.error(phoneResult.error || "Invalid phone number")
      setSubmitting(false)
      return
    }
    const normalizedPhone = phoneResult.normalized

    if (selectedPackage.packages.network.toUpperCase() === "MTN") {
      try {
        const verifyRes = await fetch("/api/verify-phone-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: [normalizedPhone] }),
        })
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json()
          const verifiedResult = verifyData.results?.[0]?.verified
          if (verifiedResult === false) {
            setSubmitting(false)
            setPendingNormalizedPhone(normalizedPhone)
            setVerifyWarningOpen(true)
            return
          }
          if (verifiedResult === true) {
            toast.success("Number verified ✓")
          }
        }
      } catch (verifyErr) {
        console.warn("[CHECKOUT] Live verification check failed, proceeding:", verifyErr)
      }
    }

    await proceedWithOrderCreation(normalizedPhone)
  }

  const handleProceedAfterVerifyWarning = async () => {
    setVerifyWarningOpen(false)
    if (pendingNormalizedPhone && selectedPackage) {
      const phone = pendingNormalizedPhone
      setPendingNormalizedPhone(null)
      setSubmitting(true)
      await proceedWithOrderCreation(phone)
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

  // Hamburger menu — grouped by real destination. Each item maps directly onto
  // the existing activeTab/rcTab state (no new routes/tabs): "Results Checker"
  // and "Retrieve Voucher" both land on the real vouchers tab, just pre-set to
  // a different rcTab sub-view. No "Mashup" entry — confirmed no real product
  // behind it (same call as the Pricing page earlier this session).
  const productItems: Array<{ label: string; icon: React.ReactNode; onClick?: () => void; href?: string; isActive: boolean }> = [
    { label: "Data Packages", icon: <ShoppingCart className="w-4 h-4" />, onClick: () => { setActiveTab("products"); setSidebarOpen(false) }, isActive: activeTab === "products" },
    { label: "Airtime Recharge", icon: <Zap className="w-4 h-4" />, onClick: () => { setActiveTab("airtime"); setSidebarOpen(false) }, isActive: activeTab === "airtime" },
    { label: "Results Checker", icon: <GraduationCap className="w-4 h-4" />, onClick: () => { setActiveTab("vouchers"); setRcTab("buy"); setSidebarOpen(false) }, isActive: activeTab === "vouchers" && rcTab === "buy" },
    ...(shop?.afa_price != null ? [{
      label: "AFA Registration", icon: <IdCard className="w-4 h-4" />,
      href: shop.subdomain ? `${shopOrigin(shop.subdomain)}/afa` : `/shop/${shopSlug}/afa`,
      isActive: false,
    }] : []),
  ]
  const accountItems: Array<{ label: string; icon: React.ReactNode; onClick: () => void; isActive: boolean }> = [
    { label: "Track My Orders", icon: <Package className="w-4 h-4" />, onClick: () => { setActiveTab("track-order"); setSidebarOpen(false) }, isActive: activeTab === "track-order" },
    { label: "Retrieve Voucher", icon: <GraduationCap className="w-4 h-4" />, onClick: () => { setActiveTab("vouchers"); setRcTab("retrieve"); setSidebarOpen(false) }, isActive: activeTab === "vouchers" && rcTab === "retrieve" },
    { label: "About Shop & Terms", icon: <AlertCircle className="w-4 h-4" />, onClick: () => { setActiveTab("about"); setSidebarOpen(false) }, isActive: activeTab === "about" },
  ]

  // Every accent on this storefront (buttons, selected states, badges) follows
  // the shop owner's own branding (Shop Profile > Branding > custom_color), not
  // Datagod's platform navy -- this page renders a different shop's brand, not
  // our own UI. Falls back to the platform navy only when a shop hasn't set one.
  const accentColor = shop?.custom_color || "#1b388b"

  return (
    <div className="min-h-screen bg-card" style={{ "--shop-accent": accentColor } as React.CSSProperties}>
      {/* Breadcrumb Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          // shop_name is shop-owner-controlled input embedded in raw HTML — escape "<"
          // so a literal "</script>" in the name can't break out of the tag.
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
          }).replace(/</g, "\\u003c"),
        }}
      />
      {/* Product Schema — one entry per package currently listed for this shop */}
      {packages.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(
              packages.map((shopPkg) => {
                const pkg = shopPkg.packages
                return generateProductSchema(
                  `${pkg.size}GB ${pkg.network} Data Bundle`,
                  pkg.price + shopPkg.profit_margin,
                  shop?.subdomain ? shopOrigin(shop.subdomain) : `https://www.datagod.store/shop/${shopSlug}`,
                  "GHS",
                  pkg.description || undefined
                )
              })
            ).replace(/</g, "\\u003c"),
          }}
        />
      )}
      {/* Navigation Bar */}
      <nav className="bg-card border-b border-border shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1">
            {/* 3-Line Hamburger Button */}
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-[var(--shop-accent)]/10 text-foreground hover:text-[var(--shop-accent)] rounded-lg transition-all duration-200 hover:shadow-md"
              aria-label="Toggle navigation menu"
              aria-expanded={sidebarOpen}
            >
              <AlignJustify className="w-6 h-6" />
            </button>

            {/* Shop Info — click to return to the service-picker home view */}
            <button onClick={() => setActiveTab("home")} className="flex items-center gap-3 min-w-0">
              <Store className="w-6 h-6 text-[var(--shop-accent)] hidden sm:block" />
              <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">
                {shop.shop_name || shop.name || "Store"}
              </h1>
            </button>
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
          className="fixed inset-0 bg-background/40 z-20 transition-opacity duration-200"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Collapsible Sidebar */}
      <aside
        className={`fixed left-0 top-0 h-screen bg-card border-r border-border w-72 transform transition-all duration-300 ease-in-out z-30 shadow-lg overflow-y-auto ${sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
      >
        <div className="relative p-6 text-center text-white" style={{ backgroundColor: "var(--shop-accent)" }}>
          <button
            onClick={() => setSidebarOpen(false)}
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-white/15 hover:bg-white/25"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-2xl bg-white/15">
            <ShoppingCart className="w-6 h-6" />
          </div>
          <p className="text-lg font-bold">{shop.shop_name || shop.name || "Store"}</p>
        </div>
        <nav className="space-y-5 p-4">
          <div>
            <p className="mb-1.5 px-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Products</p>
            <div className="space-y-1">
              {productItems.map((item) => {
                const className = `w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl text-sm font-semibold transition-colors ${item.isActive ? "bg-[var(--shop-accent)]/10 text-[var(--shop-accent)]" : "text-foreground hover:bg-accent"
                  }`
                return item.href ? (
                  <a key={item.label} href={item.href} className={className}>
                    <span className="flex items-center gap-3">{item.icon} {item.label}</span>
                  </a>
                ) : (
                  <button key={item.label} onClick={item.onClick} className={className}>
                    <span className="flex items-center gap-3">{item.icon} {item.label}</span>
                    {item.isActive && <CheckCircle2 className="w-4 h-4" />}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="border-t border-border pt-4">
            <p className="mb-1.5 px-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Account</p>
            <div className="space-y-1">
              {accountItems.map((item) => (
                <button
                  key={item.label}
                  onClick={item.onClick}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl text-sm font-semibold transition-colors ${item.isActive ? "bg-[var(--shop-accent)]/10 text-[var(--shop-accent)]" : "text-foreground hover:bg-accent"
                    }`}
                >
                  <span className="flex items-center gap-3">{item.icon} {item.label}</span>
                  {item.isActive && <CheckCircle2 className="w-4 h-4" />}
                </button>
              ))}
            </div>
          </div>
        </nav>
      </aside>
      {shop.banner_url && (
        <div className="h-40 relative overflow-hidden">
          <img
            src={shop.banner_url}
            alt={shop.shop_name || shop.name || "Shop"}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-background/30" />
        </div>
      )}

      {/* Colored Brand Hero — always renders, using the shop's custom_color when
          set or the platform navy fallback (accentColor) otherwise. This is the
          default storefront look for every shop, not an opt-in a shop owner has
          to discover in Branding; only the exact color changes. */}
      <div style={{ backgroundColor: accentColor }}>
        <div className="max-w-7xl mx-auto px-4 py-10 text-center">
          {shop.logo_url && (
            <img
              src={shop.logo_url}
              alt={shop.shop_name || "Shop"}
              className="mx-auto mb-3 h-16 w-16 rounded-2xl border-2 border-white/30 bg-white object-cover shadow-lg sm:h-20 sm:w-20"
            />
          )}
          <h2 className="text-2xl sm:text-3xl font-bold text-white">{shop.shop_name || shop.name}</h2>
          {shop.description && (
            <p className="mt-2 text-white/90 break-words text-sm sm:text-base max-w-2xl mx-auto">{shop.description}</p>
          )}
        </div>
        <SectionDivider style={shop.section_divider_style || "geometric-zigzag"} color={accentColor} />
      </div>

      <div className="max-w-7xl mx-auto px-4">
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
            {/* Home — service picker landing view */}
            {activeTab === "home" && (
              <div className="space-y-6 animate-in fade-in duration-500">
                {(shop.phone || normalizeWhatsAppLink(shopSettings?.whatsapp_link)) && (
                  <div className="rounded-2xl border border-border bg-card p-4 text-center shadow-sm">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Need Help?</p>
                    <div className="mt-1 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                      {shop.phone && (
                        <a href={`tel:${shop.phone}`} className="flex items-center gap-2 text-base font-bold text-foreground">
                          <Phone className="w-4 h-4 text-[var(--shop-accent)]" /> {shop.phone}
                        </a>
                      )}
                      {normalizeWhatsAppLink(shopSettings?.whatsapp_link) && (
                        <a
                          href={normalizeWhatsAppLink(shopSettings?.whatsapp_link)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-base font-bold text-foreground"
                        >
                          <MessageCircle className="w-4 h-4 text-[var(--shop-accent)]" /> WhatsApp Us
                        </a>
                      )}
                    </div>
                  </div>
                )}
                {shopSettings?.community_link && (
                  <a
                    href={shopSettings.community_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-sm"
                    style={{ backgroundColor: accentColor }}
                  >
                    <Users2 className="w-4 h-4" />
                    Join our community
                  </a>
                )}
                <div>
                  <p className="mb-3 text-center text-xs font-bold uppercase tracking-wide text-muted-foreground">Choose a Service</p>
                  <div className="grid grid-cols-2 gap-3">
                    {productItems.map((item) =>
                      item.href ? (
                        <a key={item.label} href={item.href} className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card p-6 text-center shadow-sm transition-shadow hover:shadow-md">
                          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--shop-accent)]/10 text-[var(--shop-accent)]">{item.icon}</span>
                          <span className="text-xs font-bold uppercase tracking-wide text-foreground">{item.label}</span>
                        </a>
                      ) : (
                        <button key={item.label} onClick={item.onClick} className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card p-6 text-center shadow-sm transition-shadow hover:shadow-md">
                          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--shop-accent)]/10 text-[var(--shop-accent)]">{item.icon}</span>
                          <span className="text-xs font-bold uppercase tracking-wide text-foreground">{item.label}</span>
                        </button>
                      )
                    )}
                  </div>
                </div>
                {showUssdCard && ussdDialCode && shopUssdCode && (
                  <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                    <div className="flex items-start gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--shop-accent)]/10 text-[var(--shop-accent)]">
                        <Smartphone className="w-5 h-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-foreground">No internet? Order by USSD</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Dial <span className="font-mono font-bold text-foreground">{ussdDialCode}</span>, then enter shop code{" "}
                          <span className="font-mono font-bold text-foreground">{shopUssdCode}</span> to buy Data Bundle, Airtime or a Results Checker.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Products Tab (Data, Airtime & Vouchers) */}
            {(activeTab === "products" || activeTab === "airtime" || activeTab === "vouchers") && (
              <div className="space-y-8">
                {/* Sub-tab Switcher */}
                <div className="flex p-1.5 bg-muted rounded-2xl w-full sm:w-fit mx-auto sm:mx-0 shadow-inner">
                  <button
                    onClick={() => setActiveTab("products")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "products"
                        ? "bg-card text-[var(--shop-accent)] shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <ShoppingCart className="w-5 h-5" />
                    Buy Data
                  </button>
                  <button
                    onClick={() => setActiveTab("airtime")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "airtime"
                        ? "bg-card text-[var(--shop-accent)] shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <Zap className="w-5 h-5" />
                    Buy Airtime
                  </button>
                  <button
                    onClick={() => setActiveTab("vouchers")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "vouchers"
                        ? "bg-card text-[var(--shop-accent)] shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <GraduationCap className="w-5 h-5" />
                    Results Vouchers
                  </button>
                  {shop?.afa_price != null && (
                    <a
                      href={shop.subdomain ? `${shopOrigin(shop.subdomain)}/afa` : `/shop/${shopSlug}/afa`}
                      className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 text-muted-foreground hover:text-foreground hover:bg-card/50"
                    >
                      <IdCard className="w-5 h-5" />
                      AFA Registration
                    </a>
                  )}
                </div>

                {activeTab === "products" ? (
                  /* Data Packages Section */
                  <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div>
                      <h2 className="text-2xl font-black mb-6 text-foreground border-l-4 border-[var(--shop-accent)] pl-4">Fast Data Packages</h2>

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
                              const netColor = networkColorFor(network as string)
                              const isSelected = selectedNetwork === network

                              return (
                                <button
                                  key={network}
                                  onClick={() => setSelectedNetwork(network as string)}
                                  className="relative flex flex-col items-center gap-2 rounded-2xl border-2 bg-card p-4 text-center shadow-sm transition-all"
                                  style={{ borderColor: isSelected ? netColor : "transparent" }}
                                >
                                  {isSelected && (
                                    <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-success text-white">
                                      <CheckCircle2 className="h-3 w-3" />
                                    </span>
                                  )}
                                  <span className="grid h-14 w-14 place-items-center rounded-full" style={{ backgroundColor: `${netColor}22` }}>
                                    <img src={getNetworkLogo(network as string)} alt={network as string} className="h-9 w-9 object-contain" />
                                  </span>
                                  <p className="text-sm font-bold text-foreground">{network}</p>
                                  {availableCount > 0 ? (
                                    <p className="flex items-center gap-1 text-xs font-semibold text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" /> Live</p>
                                  ) : (
                                    <p className="text-xs text-muted-foreground">No plans yet</p>
                                  )}
                                </button>
                              )
                            })}
                          </div>

                          {/* Standalone MTN number checker — MTN-specific since the
                              underlying registration/verification system only
                              covers MTN today. */}
                          {selectedNetwork === "MTN" && (
                            <div className="mb-8 rounded-2xl border border-border bg-card p-5 shadow-sm">
                              <button
                                type="button"
                                onClick={() => setMtnCheckExpanded((v) => !v)}
                                className="flex w-full items-start gap-3 text-left"
                              >
                                <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600">
                                  <ShieldCheck className="w-4 h-4" />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="font-bold text-foreground">Check your MTN number</p>
                                  <p className="text-sm text-muted-foreground">Make sure it can receive data before you pay</p>
                                </div>
                                {mtnCheckExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
                              </button>
                              {mtnCheckExpanded && (
                                <div className="mt-1 pl-12">
                                  <div className="mt-3 flex gap-2">
                                    <input
                                      value={mtnCheckPhone}
                                      onChange={(e) => { setMtnCheckPhone(e.target.value); setMtnCheckStatus("idle") }}
                                      placeholder="024XXXXXXX"
                                      className="min-w-0 flex-1 rounded-xl border border-border bg-background px-4 py-2.5 text-sm focus:border-[var(--shop-accent)] focus:outline-none"
                                    />
                                    <Button
                                      onClick={handleCheckMtnNumber}
                                      disabled={mtnCheckStatus === "checking"}
                                      className="shrink-0 bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90"
                                    >
                                      {mtnCheckStatus === "checking" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check"}
                                    </Button>
                                  </div>

                                  {mtnCheckStatus === "verified" && (
                                    <p className="mt-3 flex items-center gap-2 rounded-xl bg-success/10 p-3 text-sm font-medium text-success">
                                      <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> This number is ready to receive MTN data.
                                    </p>
                                  )}
                                  {mtnCheckStatus === "unverified" && (
                                    <p className="mt-3 flex items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-sm font-medium text-amber-700">
                                      <AlertTriangle className="w-4 h-4 flex-shrink-0" /> Not yet confirmed — you can still order, but delivery may be delayed until it's confirmed.
                                    </p>
                                  )}
                                  {mtnCheckStatus === "error" && (
                                    <p className="mt-3 text-sm text-destructive">Enter a valid MTN number to check.</p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Packages Grid */}
                          {selectedNetwork && (
                            <div ref={packagesRef} className="py-10 border-t border-border animate-in fade-in slide-in-from-bottom-8 duration-700">
                              <div className="flex items-center gap-4 mb-8">
                                <div className="p-3 bg-[var(--shop-accent)] rounded-2xl">
                                  <img src={getNetworkLogo(selectedNetwork)} className="w-8 h-8 object-contain" alt={selectedNetwork} />
                                </div>
                                <div>
                                  <h2 className="text-2xl font-black text-foreground uppercase tracking-tight">{selectedNetwork} Offers</h2>
                                  <p className="text-sm font-medium text-muted-foreground">Pick the perfect plan for your needs</p>
                                </div>
                              </div>

                              <div className="mb-6 flex gap-2">
                                <div className="relative flex-1">
                                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                  <input
                                    value={packageSearch}
                                    onChange={(e) => setPackageSearch(e.target.value)}
                                    placeholder="Search packages..."
                                    className="w-full rounded-xl border border-border bg-card py-2.5 pl-10 pr-3 text-sm focus:border-[var(--shop-accent)] focus:outline-none"
                                  />
                                </div>
                                <div className="flex shrink-0 overflow-hidden rounded-xl border border-border">
                                  <button
                                    onClick={() => setPackageViewMode("grid")}
                                    aria-label="Grid view"
                                    className={`px-3 ${packageViewMode === "grid" ? "bg-foreground text-background" : "bg-card text-muted-foreground"}`}
                                  >
                                    <LayoutGrid className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={() => setPackageViewMode("list")}
                                    aria-label="List view"
                                    className={`px-3 ${packageViewMode === "list" ? "bg-foreground text-background" : "bg-card text-muted-foreground"}`}
                                  >
                                    <List className="h-4 w-4" />
                                  </button>
                                </div>
                              </div>

                              {packages
                                .filter(p => p.packages.network === selectedNetwork)
                                .filter(p => {
                                  if (!packageSearch.trim()) return true
                                  const q = packageSearch.trim().toLowerCase()
                                  return p.packages.size?.toLowerCase().includes(q) || p.packages.description?.toLowerCase().includes(q)
                                }).length === 0 && (
                                <p className="py-8 text-center text-sm text-muted-foreground">No packages match &quot;{packageSearch}&quot;.</p>
                              )}

                              <div className={packageViewMode === "grid" ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" : "grid grid-cols-1 gap-3"}>
                                {packages
                                  .filter(p => p.packages.network === selectedNetwork)
                                  .filter(p => {
                                    if (!packageSearch.trim()) return true
                                    const q = packageSearch.trim().toLowerCase()
                                    return p.packages.size?.toLowerCase().includes(q) || p.packages.description?.toLowerCase().includes(q)
                                  })
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
                                    const netColor = networkColorFor(pkg.network)
                                    const inStock = shopPkg.is_available && globalOrderingEnabled

                                    return (
                                      <div
                                        key={shopPkg.id}
                                        className={`overflow-hidden rounded-2xl shadow-md transition-all ${inStock ? "hover:shadow-xl hover:-translate-y-1" : "opacity-60 grayscale"}`}
                                        style={{ backgroundColor: netColor }}
                                      >
                                        <div className="flex items-start justify-between p-4 pb-2">
                                          <span className="grid h-8 w-8 place-items-center rounded-full bg-white/60">
                                            <img src={getNetworkLogo(pkg.network)} alt="" className="h-5 w-5 object-contain" />
                                          </span>
                                          <span className="rounded-full bg-black/15 px-2.5 py-1 text-[11px] font-bold text-black/70">{pkg.network}</span>
                                        </div>
                                        <div className="px-4 pb-4 text-center">
                                          <p className="text-4xl font-black text-black/85">{pkg.size}GB</p>
                                          <p className="mt-1 text-lg font-bold text-black/70">GH₵{totalPrice.toFixed(2)}</p>
                                          {pkg.description && <p className="mt-1 text-xs text-black/60">{pkg.description}</p>}
                                          {!inStock && <p className="mt-1 text-xs font-semibold text-black/60">{!shopPkg.is_available ? "Out of stock" : "Ordering paused"}</p>}
                                        </div>
                                        <button
                                          onClick={() => handleBuyNow(shopPkg)}
                                          disabled={!inStock}
                                          className="flex w-full items-center justify-center gap-2 py-3 text-sm font-bold text-black/80 disabled:cursor-not-allowed"
                                          style={{ backgroundColor: `rgba(0,0,0,0.12)` }}
                                        >
                                          <ShoppingCart className="h-4 w-4" /> Buy Now
                                        </button>
                                      </div>
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
                        className={`flex-1 sm:flex-none px-5 py-2 rounded-lg font-semibold text-sm transition-all duration-200 ${rcTab === "buy" ? "bg-card text-[var(--shop-accent)] shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Buy Vouchers
                      </button>
                      <button
                        onClick={() => setRcTab("retrieve")}
                        className={`flex-1 sm:flex-none px-5 py-2 rounded-lg font-semibold text-sm transition-all duration-200 ${rcTab === "retrieve" ? "bg-card text-[var(--shop-accent)] shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Retrieve Vouchers
                      </button>
                      <button
                        onClick={() => setRcTab("check")}
                        className={`flex-1 sm:flex-none px-5 py-2 rounded-lg font-semibold text-sm transition-all duration-200 ${rcTab === "check" ? "bg-card text-[var(--shop-accent)] shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Check My Results
                      </button>
                    </div>
                    {rcTab === "buy"
                      ? <ResultsCheckerStorefrontForm shop={shop} shopSlug={shopSlug} />
                      : rcTab === "retrieve"
                      ? <VoucherLookup />
                      : <ResultsCheckServiceForm shop={shop} shopSlug={shopSlug} />
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

                {/* Become a sub-agent under this shop — customer-initiated
                    request queue, reviewed by the shop owner in their dashboard. */}
                <Card className="border-0 shadow-md">
                  <CardContent className="pt-6">
                    <SubAgentRequestForm shopSlug={shopSlug} />
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
                    <OrderStatusSearch shopSlug={shopSlug} shopName={shop?.shop_name} />
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Floating WhatsApp button — persistent across tabs, same real
          shopSettings.whatsapp_link the hero used to bury a text button for. */}
      {normalizeWhatsAppLink(shopSettings?.whatsapp_link) && (
        <a
          href={normalizeWhatsAppLink(shopSettings?.whatsapp_link)!}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-5 right-5 z-40 grid h-14 w-14 place-items-center rounded-full bg-success text-white shadow-xl transition-transform hover:scale-105"
          aria-label="Contact on WhatsApp"
        >
          <MessageCircle className="h-6 w-6" />
        </a>
      )}

      {
        checkoutOpen && selectedPackage && (() => {
          const netColor = networkColorFor(selectedPackage.packages.network)
          const detectedProvider = detectMomoProviderClient(paymentPhone)
          const chosenProvider = momoNetworkChoice ?? detectedProvider
          const providerMismatch = momoNetworkChoice && detectedProvider && momoNetworkChoice !== detectedProvider
          const total = selectedPackage.selling_price !== undefined ? selectedPackage.selling_price : (selectedPackage.packages.price + selectedPackage.profit_margin)
          return (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
              onClick={() => { setCheckoutOpen(false); setOrderData({ customer_name: "", customer_email: "", customer_phone: "" }) }}
            >
              <div
                className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl bg-card"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Drag handle + close */}
                <div className="relative flex shrink-0 justify-center pt-3 pb-1">
                  <div className="h-1 w-10 rounded-full bg-border" />
                  <button
                    onClick={() => { setCheckoutOpen(false); setOrderData({ customer_name: "", customer_email: "", customer_phone: "" }) }}
                    className="absolute right-4 top-2 grid h-8 w-8 place-items-center rounded-full bg-muted text-foreground"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-2">
                  {/* Network · size · price pill */}
                  <div className="flex items-center justify-between rounded-2xl px-4 py-3" style={{ backgroundColor: netColor }}>
                    <span className="flex items-center gap-2 font-bold text-black/80">
                      <img src={getNetworkLogo(selectedPackage.packages.network)} alt="" className="h-5 w-5 object-contain" />
                      {selectedPackage.packages.network} · {selectedPackage.packages.size}GB
                    </span>
                    <span className="font-black text-black/80">GH₵{total.toFixed(2)}</span>
                  </div>

                  <div>
                    <Label>Full name</Label>
                    <Input
                      value={orderData.customer_name}
                      onChange={(e) => setOrderData({ ...orderData, customer_name: e.target.value })}
                      placeholder="e.g. Kwame Mensah"
                      className="mt-1 bg-card"
                    />
                  </div>

                  <div>
                    <Label>Beneficiary number <span className="font-normal text-muted-foreground">(gets the data)</span></Label>
                    <Input
                      value={orderData.customer_phone}
                      onChange={(e) => {
                        setOrderData({ ...orderData, customer_phone: e.target.value })
                        if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode("") }
                      }}
                      placeholder="0241234567"
                      className="mt-1 bg-card"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {selectedPackage?.packages?.network
                        ? `Must be a ${selectedPackage.packages.network} number — the prefix is checked at checkout.`
                        : "Format: 10 digits starting with 02 or 05 (e.g., 0201234567)"}
                    </p>
                  </div>

                  <HoneypotField value={honeypot} onChange={setHoneypot} />

                  {/* Payment-number step. Shown whenever OTP verification OR direct
                      charge is on — both need the on-page MoMo number. Without
                      either, the sheet stays this short and Paystack's own hosted
                      page collects payment. */}
                  {(otpRequired || directCharge) && (
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={sameAsMomo}
                          onChange={(e) => setSameAsMomo(e.target.checked)}
                          className="h-4 w-4 rounded border-border"
                        />
                        Use this number for Mobile Money payment
                      </label>

                      <div>
                        <Label>Mobile Money number <span className="font-normal text-muted-foreground">(to pay)</span></Label>
                        <Input
                          value={paymentPhone}
                          onChange={(e) => {
                            setPaymentPhone(e.target.value)
                            if (sameAsMomo) setSameAsMomo(false)
                            if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode(""); otpCooldown.reset() }
                          }}
                          placeholder="0241234567"
                          className="mt-1 bg-card"
                          disabled={otpRequired && otpVerified}
                        />
                      </div>

                      <div>
                        <Label>Network</Label>
                        <div className="mt-1 grid grid-cols-3 gap-2">
                          {(["mtn", "vod", "tgo"] as const).map((p) => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => setMomoNetworkChoice(p)}
                              className={`flex items-center justify-center gap-1.5 rounded-xl border-2 py-2.5 text-sm font-semibold ${chosenProvider === p ? "border-[var(--shop-accent)]" : "border-border"}`}
                            >
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p === "mtn" ? NETWORK_BRAND_COLOR.MTN : p === "vod" ? NETWORK_BRAND_COLOR.Telecel : NETWORK_BRAND_COLOR["AT - iShare"] }} />
                              {MOMO_NETWORK_LABEL[p]}
                            </button>
                          ))}
                        </div>
                        {providerMismatch && (
                          <p className="mt-1 text-xs text-amber-600">That number doesn&apos;t look like a {MOMO_NETWORK_LABEL[momoNetworkChoice!]} number — double check before proceeding.</p>
                        )}
                      </div>

                      {otpRequired && (!otpVerified ? (
                        !otpSent ? (
                          <Button
                            type="button"
                            onClick={handleSendCheckoutOtp}
                            disabled={sendingOtp || otpCooldown.seconds > 0}
                            className="w-full bg-[var(--shop-accent)] hover:bg-[var(--shop-accent)] text-white"
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
                                className="flex-1 bg-[var(--shop-accent)] hover:bg-[var(--shop-accent)] text-white"
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

                  <div>
                    <Label>Email <span className="font-normal text-muted-foreground">(for receipt — optional)</span></Label>
                    <Input
                      type="email"
                      value={orderData.customer_email}
                      onChange={(e) => setOrderData({ ...orderData, customer_email: e.target.value })}
                      placeholder="you@example.com"
                      className="mt-1 bg-card"
                    />
                  </div>
                </div>

                {/* Fixed action footer — stays visible while the form above scrolls */}
                <div className="shrink-0 space-y-3 p-5">
                  {turnstileEnabled && (
                    <div className="flex justify-center">
                      <TurnstileWidget onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
                    </div>
                  )}
                  <Button
                    onClick={handleSubmitOrder}
                    disabled={submitting || (turnstileEnabled && !turnstileToken) || (otpRequired && !otpVerified) || (directCharge && !otpRequired && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, "")))}
                    className="w-full bg-success text-white hover:bg-success/90"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>Proceed to payment<ArrowRight className="w-4 h-4 ml-2" /></>
                    )}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">A small payment fee applies. Confirm the exact total on your phone.</p>
                </div>
              </div>
            </div>
          )
        })()
      }

      {
        verifyWarningOpen && (
          <div className="fixed inset-0 bg-background/50 flex items-center justify-center p-4 z-[60]">
            <Card className="w-full max-w-md bg-card">
              <CardHeader>
                <CardTitle>Number not yet verified</CardTitle>
                <CardDescription>
                  This number hasn&apos;t been verified yet. If you proceed, your order will still be processed, but delivery may be delayed until the number is confirmed — you&apos;ll receive your data automatically once that happens.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setVerifyWarningOpen(false); setPendingNormalizedPhone(null) }}>Change number</Button>
                <Button disabled={submitting} onClick={handleProceedAfterVerifyWarning}>
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    "Proceed anyway"
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>
        )
      }

      {/* Live Mobile Money prompt modal (direct-charge flow). Stays on-page while
          the customer approves the prompt; polls order status until the webhook
          flips it to completed, then shows the order summary. */}
      {momoModal && (
        <div className="fixed inset-0 bg-background/60 flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-md bg-card">
            {momoModal.state === "awaiting" && (
              <CardContent className="pt-8 pb-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-[var(--shop-accent)] flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-primary-foreground animate-spin" />
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

            {momoModal.state === "otp" && (
              <CardContent className="pt-8 pb-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-[var(--shop-accent)] flex items-center justify-center">
                  <svg className="w-8 h-8 text-primary-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Enter the code sent to your phone</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Your provider sent a one-time code to{" "}
                    <span className="font-semibold">{momoModal.summary?.paymentPhone}</span> to approve this payment.
                  </p>
                </div>
                <Input
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  placeholder="Enter OTP"
                  value={momoOtpInput}
                  onChange={(e) => setMomoOtpInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitMomoOtp() }}
                  className="text-center text-lg tracking-widest"
                  disabled={momoOtpSubmitting}
                />
                <Button
                  onClick={submitMomoOtp}
                  disabled={momoOtpSubmitting || !momoOtpInput.trim()}
                  className="w-full bg-gradient-to-r from-[var(--shop-accent)] to-[var(--shop-accent)] hover:from-[var(--shop-accent)] hover:to-[var(--shop-accent)]"
                >
                  {momoOtpSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit code"}
                </Button>
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
                    setMomoOtpInput(""); setMomoOtpSubmitting(false)
                  }}
                  className="w-full bg-gradient-to-r from-[var(--shop-accent)] to-[var(--shop-accent)] hover:from-[var(--shop-accent)] hover:to-[var(--shop-accent)]"
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
                  <Button variant="outline" onClick={() => { setMomoModal(null); setMomoOtpInput(""); setMomoOtpSubmitting(false) }} className="flex-1">Close</Button>
                  <Button onClick={() => { setMomoModal(null); setMomoOtpInput(""); setMomoOtpSubmitting(false); setCheckoutOpen(true) }} className="flex-1 bg-[var(--shop-accent)] hover:bg-[var(--shop-accent)] text-white">Try again</Button>
                </div>
              </CardContent>
            )}
          </Card>
        </div>
      )}

      {/* Floating WhatsApp Icon */}
      {
        normalizeWhatsAppLink(shopSettings?.whatsapp_link) && (
          <a
            href={normalizeWhatsAppLink(shopSettings?.whatsapp_link)!}
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
            <AlignJustify className="w-4 h-4 text-[var(--shop-accent)]" />
            Platform Terms of Service
          </CardTitle>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-[var(--shop-accent)] hover:text-[var(--shop-accent)] font-medium border border-border hover:border-[var(--shop-accent)] rounded px-2 py-0.5 transition-colors"
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
              <p className="text-xs font-bold text-[var(--shop-accent)] mb-1">{s.title}</p>
              <p className="text-xs text-foreground leading-relaxed">{s.body}</p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground pt-1">Last updated: {formattedDate}</p>
        </CardContent>
      )}
    </Card>
  )
}

function OrderStatusSearch({ shopSlug, shopName }: { shopSlug: string; shopName: string }) {
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
          // getShopBySlug no longer exposes the shop id (server-only); send the
          // slug — the API resolves it server-side (subdomain OR shop_slug).
          shopSlug,
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
        return "bg-[var(--shop-accent)]/10 text-[var(--shop-accent)] border-[var(--shop-accent)]/20"
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
                          <Package className="w-4 h-4 text-[var(--shop-accent)]" />
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
