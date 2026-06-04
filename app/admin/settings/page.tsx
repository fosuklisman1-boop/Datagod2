"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAdminProtected } from "@/hooks/use-admin"
import { useAuth } from "@/lib/auth-context"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { Loader2, Save, ExternalLink, MessageCircle, Copy, Check, Link as LinkIcon, Bell, DollarSign, Power, Megaphone, FileText } from "lucide-react"
import { supportSettingsService } from "@/lib/support-settings-service"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import PhoneBlacklistManager from "@/components/admin/phone-blacklist-manager"
import AirtimeSettingsCard from "@/components/admin/airtime-settings-card"

export default function AdminSettingsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const { user } = useAuth()
  const [joinCommunityLink, setJoinCommunityLink] = useState("")
  const [whatsappNumber, setWhatsappNumber] = useState("")
  const [supportEmail, setSupportEmail] = useState("")
  const [supportPhone, setSupportPhone] = useState("")
  const [previewWhatsappUrl, setPreviewWhatsappUrl] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)

  // App Control settings
  const [orderingEnabled, setOrderingEnabled] = useState(true)
  
  // Feature Toggles
  const [signupsEnabled, setSignupsEnabled] = useState(true)
  const [walletTopupsEnabled, setWalletTopupsEnabled] = useState(true)
  const [upgradesEnabled, setUpgradesEnabled] = useState(true)
  const [signupDefaultRole, setSignupDefaultRole] = useState<'user' | 'dealer'>('user')

  // USSD price tier
  const [ussdPriceTier, setUssdPriceTier] = useState<"regular" | "dealer">("regular")
  const [savingUssdTier, setSavingUssdTier] = useState(false)

  // MTN Provider settings
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina">("sykes")
  const [savingProvider, setSavingProvider] = useState(false)

  // Announcement settings
  const [announcementEnabled, setAnnouncementEnabled] = useState(false)
  const [announcementTitle, setAnnouncementTitle] = useState("")
  const [announcementMessage, setAnnouncementMessage] = useState("")

  // Global Storefront Override settings
  const [storefrontAnnouncementEnabled, setStorefrontAnnouncementEnabled] = useState(false)
  const [storefrontAnnouncementTitle, setStorefrontAnnouncementTitle] = useState("")
  const [storefrontAnnouncementMessage, setStorefrontAnnouncementMessage] = useState("")

  // Fee settings
  const [paystackFeePercentage, setPaystackFeePercentage] = useState(3.0)
  const [walletTopupFeePercentage, setWalletTopupFeePercentage] = useState(0)
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)

  // Price adjustment settings (per network)
  const [priceAdjustmentMtn, setPriceAdjustmentMtn] = useState(0)
  const [priceAdjustmentTelecel, setPriceAdjustmentTelecel] = useState(0)
  const [priceAdjustmentAtIshare, setPriceAdjustmentAtIshare] = useState(0)
  const [priceAdjustmentAtBigtime, setPriceAdjustmentAtBigtime] = useState(0)

  // Christmas theme settings
  const [christmasThemeEnabled, setChristmasThemeEnabled] = useState(false)
  const [savingChristmasTheme, setSavingChristmasTheme] = useState(false)

  // Cloudflare Turnstile master kill switch
  const [turnstileEnabled, setTurnstileEnabled] = useState(true)
  const [savingTurnstile, setSavingTurnstile] = useState(false)

  // Storefront checkout phone-OTP gate
  const [checkoutOtpEnabled, setCheckoutOtpEnabled] = useState(false)
  const [savingCheckoutOtp, setSavingCheckoutOtp] = useState(false)
  const [walletLockEnabled, setWalletLockEnabled] = useState(false)
  const [savingWalletLock, setSavingWalletLock] = useState(false)
  // Direct MoMo charge toggles (independent of the OTP gates above)
  const [storefrontDirectCharge, setStorefrontDirectCharge] = useState(false)
  const [savingStorefrontDirect, setSavingStorefrontDirect] = useState(false)
  const [walletDirectCharge, setWalletDirectCharge] = useState(false)
  const [savingWalletDirect, setSavingWalletDirect] = useState(false)
  const [verifiedCount, setVerifiedCount] = useState<number | null>(null)
  const [resettingVerifications, setResettingVerifications] = useState(false)

  // Guest purchase settings
  const [guestPurchaseUrl, setGuestPurchaseUrl] = useState("")
  const [guestPurchaseButtonText, setGuestPurchaseButtonText] = useState("Buy as Guest")

  // Terms of Service
  const [termsContent, setTermsContent] = useState("")
  const [termsLastUpdated, setTermsLastUpdated] = useState<string | null>(null)
  const [savingTerms, setSavingTerms] = useState(false)

  const [domainUrls] = useState([
    { name: "Main App", url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000" },
    { name: "Admin Dashboard", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/admin` },
    { name: "Dashboard", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/dashboard` },
    { name: "Login", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/login` },
    { name: "Sign Up", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/signup` },
  ])

  // Fetch settings
  useEffect(() => {
    if (!user) return

    const fetchSettings = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const response = await fetch("/api/admin/settings", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        const data = await response.json()

        if (data.join_community_link) {
          setJoinCommunityLink(data.join_community_link)
        }

        // Load support settings
        const supportSettings = await supportSettingsService.getSupportSettings()
        setWhatsappNumber(supportSettings?.support_whatsapp || "")
        setSupportEmail(supportSettings?.support_email || "")
        setSupportPhone(supportSettings?.support_phone || "")
        if (supportSettings?.support_whatsapp) {
          const url = supportSettingsService.formatWhatsAppURL(
            supportSettings.support_whatsapp,
            "Hi, I need help resetting my password."
          )
          setPreviewWhatsappUrl(url)
        }

        // Load guest purchase settings
        if (supportSettings?.guest_purchase_url) {
          setGuestPurchaseUrl(supportSettings.guest_purchase_url)
        }
        if (supportSettings?.guest_purchase_button_text) {
          setGuestPurchaseButtonText(supportSettings.guest_purchase_button_text)
        }

        // Load ordering settings
        if (data.ordering_enabled !== undefined) {
          setOrderingEnabled(data.ordering_enabled)
        }

        // Load feature toggles
        if (data.signups_enabled !== undefined) {
          setSignupsEnabled(data.signups_enabled)
        }
        if (data.signup_default_role) {
          setSignupDefaultRole(data.signup_default_role)
        }
        if (data.wallet_topups_enabled !== undefined) {
          setWalletTopupsEnabled(data.wallet_topups_enabled)
        }
        if (data.upgrades_enabled !== undefined) {
          setUpgradesEnabled(data.upgrades_enabled)
        }

        // Load announcement settings
        if (data.announcement_enabled !== undefined) {
          setAnnouncementEnabled(data.announcement_enabled)
        }
        if (data.announcement_title) {
          setAnnouncementTitle(data.announcement_title)
        }
        if (data.announcement_message) {
          setAnnouncementMessage(data.announcement_message)
        }

        // Load storefront override settings
        if (data.storefront_announcement_enabled !== undefined) {
          setStorefrontAnnouncementEnabled(data.storefront_announcement_enabled)
        }
        if (data.storefront_announcement_title) {
          setStorefrontAnnouncementTitle(data.storefront_announcement_title)
        }
        if (data.storefront_announcement_message) {
          setStorefrontAnnouncementMessage(data.storefront_announcement_message)
        }

        // Load fee settings
        if (data.paystack_fee_percentage !== undefined) {
          setPaystackFeePercentage(data.paystack_fee_percentage)
        }
        if (data.wallet_topup_fee_percentage !== undefined) {
          setWalletTopupFeePercentage(data.wallet_topup_fee_percentage)
        }
        if (data.withdrawal_fee_percentage !== undefined) {
          setWithdrawalFeePercentage(data.withdrawal_fee_percentage)
        }

        // Load terms content
        if (data.terms_content !== undefined) {
          setTermsContent(data.terms_content || "")
        }
        if (data.terms_last_updated) {
          setTermsLastUpdated(data.terms_last_updated)
        }

        // Load USSD price tier
        if (data.ussd_price_tier) {
          setUssdPriceTier(data.ussd_price_tier as "regular" | "dealer")
        }

        // Load price adjustment settings
        if (data.price_adjustment_mtn !== undefined) {
          setPriceAdjustmentMtn(data.price_adjustment_mtn)
        }
        if (data.price_adjustment_telecel !== undefined) {
          setPriceAdjustmentTelecel(data.price_adjustment_telecel)
        }
        if (data.price_adjustment_at_ishare !== undefined) {
          setPriceAdjustmentAtIshare(data.price_adjustment_at_ishare)
        }
        if (data.price_adjustment_at_bigtime !== undefined) {
          setPriceAdjustmentAtBigtime(data.price_adjustment_at_bigtime)
        }

        // Load Christmas theme setting
        const christmasResponse = await fetch("/api/admin/christmas-theme")
        const christmasData = await christmasResponse.json()
        if (christmasData.christmas_theme_enabled !== undefined) {
          setChristmasThemeEnabled(christmasData.christmas_theme_enabled)
        }

        // Load MTN provider setting
        const providerResponse = await fetch("/api/admin/settings/mtn-provider", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        const providerData = await providerResponse.json()
        if (providerData.provider) {
          setMtnProvider(providerData.provider)
        }

        // Load Turnstile kill-switch state
        const turnstileResponse = await fetch("/api/admin/settings/turnstile", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        if (turnstileResponse.ok) {
          const turnstileData = await turnstileResponse.json()
          if (typeof turnstileData.enabled === "boolean") {
            setTurnstileEnabled(turnstileData.enabled)
          }
        }

        // Load checkout phone-OTP gate state
        const otpResponse = await fetch("/api/admin/settings/storefront-otp", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        if (otpResponse.ok) {
          const otpData = await otpResponse.json()
          if (typeof otpData.enabled === "boolean") {
            setCheckoutOtpEnabled(otpData.enabled)
          }
        }

        // Load wallet/upgrade payment-lock state
        const walletLockResponse = await fetch("/api/admin/settings/wallet-otp", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        if (walletLockResponse.ok) {
          const wlData = await walletLockResponse.json()
          if (typeof wlData.enabled === "boolean") {
            setWalletLockEnabled(wlData.enabled)
          }
        }

        // Load direct MoMo charge states (independent of the OTP gates)
        const storefrontDirectResponse = await fetch("/api/admin/settings/storefront-direct-charge", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        if (storefrontDirectResponse.ok) {
          const sdData = await storefrontDirectResponse.json()
          if (typeof sdData.enabled === "boolean") {
            setStorefrontDirectCharge(sdData.enabled)
          }
        }
        const walletDirectResponse = await fetch("/api/admin/settings/wallet-direct-charge", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        if (walletDirectResponse.ok) {
          const wdData = await walletDirectResponse.json()
          if (typeof wdData.enabled === "boolean") {
            setWalletDirectCharge(wdData.enabled)
          }
        }

        // Load count of currently OTP-verified numbers
        const verifResponse = await fetch("/api/admin/phone-verifications/reset", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        if (verifResponse.ok) {
          const vData = await verifResponse.json()
          if (typeof vData.verified === "number") {
            setVerifiedCount(vData.verified)
          }
        }
      } catch (error) {
        console.error("[SETTINGS] Error fetching settings:", error)
        const errorMessage = error instanceof Error ? error.message : "Failed to load settings"
        toast.error(errorMessage)
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
  }, [user])

  const handleWhatsappChange = (value: string) => {
    setWhatsappNumber(value)
    if (value) {
      const url = supportSettingsService.formatWhatsAppURL(value, "Hi, I need help resetting my password.")
      setPreviewWhatsappUrl(url)
    } else {
      setPreviewWhatsappUrl("")
    }
  }

  const copyToClipboard = (url: string) => {
    navigator.clipboard.writeText(url)
    setCopiedUrl(url)
    toast.success("URL copied to clipboard!")
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  const handleSaveTerms = async () => {
    setSavingTerms(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ terms_content: termsContent }),
      })
      if (!response.ok) throw new Error("Failed to save terms")
      const result = await response.json()
      if (result.settings?.terms_last_updated) {
        setTermsLastUpdated(result.settings.terms_last_updated)
      }
      toast.success("Terms of Service saved!")
    } catch (error) {
      toast.error("Failed to save terms")
    } finally {
      setSavingTerms(false)
    }
  }

  const handleChristmasThemeToggle = async (enabled: boolean) => {
    setSavingChristmasTheme(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Authentication required")
        setSavingChristmasTheme(false)
        return
      }

      const response = await fetch("/api/admin/christmas-theme", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ christmas_theme_enabled: enabled }),
      })

      if (!response.ok) {
        throw new Error("Failed to update Christmas theme")
      }

      setChristmasThemeEnabled(enabled)
      toast.success(
        enabled ? "🎄 Christmas theme enabled!" : "Christmas theme disabled"
      )
    } catch (error) {
      console.error("Error updating Christmas theme:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to update Christmas theme"
      toast.error(errorMessage)
    } finally {
      setSavingChristmasTheme(false)
    }
  }

  const handleCheckoutOtpToggle = async (enabled: boolean) => {
    setSavingCheckoutOtp(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        setSavingCheckoutOtp(false)
        return
      }
      const response = await fetch("/api/admin/settings/storefront-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update checkout OTP setting")
      }
      setCheckoutOtpEnabled(enabled)
      toast.success(
        enabled
          ? "🔐 Checkout phone-OTP is now REQUIRED — guests must verify their phone"
          : "Checkout phone-OTP disabled — guest checkout open"
      )
    } catch (error) {
      console.error("Error updating checkout OTP:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update checkout OTP setting")
    } finally {
      setSavingCheckoutOtp(false)
    }
  }

  const handleWalletLockToggle = async (enabled: boolean) => {
    setSavingWalletLock(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        setSavingWalletLock(false)
        return
      }
      const response = await fetch("/api/admin/settings/wallet-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update wallet protection setting")
      }
      setWalletLockEnabled(enabled)
      toast.success(
        enabled
          ? "🔐 Wallet & upgrade protection ON — top-ups/upgrades can't send MoMo prompts (card/bank only)"
          : "Wallet & upgrade protection OFF — MoMo top-ups/upgrades open again"
      )
    } catch (error) {
      console.error("Error updating wallet protection:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update wallet protection setting")
    } finally {
      setSavingWalletLock(false)
    }
  }

  const handleStorefrontDirectToggle = async (enabled: boolean) => {
    setSavingStorefrontDirect(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        setSavingStorefrontDirect(false)
        return
      }
      const response = await fetch("/api/admin/settings/storefront-direct-charge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update storefront direct charge setting")
      }
      setStorefrontDirectCharge(enabled)
      toast.success(
        enabled
          ? "💸 Storefront direct MoMo charge ON — customers pay on-page; hosted MoMo is disabled"
          : "Storefront direct charge OFF — checkout uses the hosted Paystack page"
      )
    } catch (error) {
      console.error("Error updating storefront direct charge:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update storefront direct charge setting")
    } finally {
      setSavingStorefrontDirect(false)
    }
  }

  const handleWalletDirectToggle = async (enabled: boolean) => {
    setSavingWalletDirect(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        setSavingWalletDirect(false)
        return
      }
      const response = await fetch("/api/admin/settings/wallet-direct-charge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update wallet direct charge setting")
      }
      setWalletDirectCharge(enabled)
      toast.success(
        enabled
          ? "💸 Wallet/upgrade direct MoMo charge ON — paid on-page; hosted MoMo is disabled"
          : "Wallet/upgrade direct charge OFF — uses the hosted Paystack page"
      )
    } catch (error) {
      console.error("Error updating wallet direct charge:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update wallet direct charge setting")
    } finally {
      setSavingWalletDirect(false)
    }
  }

  const handleResetVerifications = async () => {
    if (!window.confirm(
      "Reset ALL phone verifications?\n\nEvery customer — including returning ones — will have to verify their payment number again (one SMS) on their next order. This also clears any numbers an attacker verified.\n\nContinue?"
    )) return
    setResettingVerifications(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        setResettingVerifications(false)
        return
      }
      const response = await fetch("/api/admin/phone-verifications/reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || "Reset failed")
      setVerifiedCount(0)
      toast.success(`✓ Reset ${data.deleted ?? 0} phone verification(s) — all numbers must re-verify`)
    } catch (error) {
      console.error("Error resetting verifications:", error)
      toast.error(error instanceof Error ? error.message : "Failed to reset verifications")
    } finally {
      setResettingVerifications(false)
    }
  }

  const handleTurnstileToggle = async (enabled: boolean) => {
    setSavingTurnstile(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        setSavingTurnstile(false)
        return
      }

      const response = await fetch("/api/admin/settings/turnstile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ enabled }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update Turnstile setting")
      }

      setTurnstileEnabled(enabled)
      toast.success(
        enabled
          ? "🔒 Turnstile verification re-enabled — security on"
          : "⚠️ Turnstile verification DISABLED — orders will skip CAPTCHA"
      )
    } catch (error) {
      console.error("Error updating Turnstile setting:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update Turnstile setting")
    } finally {
      setSavingTurnstile(false)
    }
  }

  const handleUssdPriceTierChange = async (tier: "regular" | "dealer") => {
    setSavingUssdTier(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ussd_price_tier: tier }),
      })
      if (!response.ok) throw new Error("Failed to update USSD price tier")
      setUssdPriceTier(tier)
      toast.success(`USSD price tier set to ${tier === 'dealer' ? 'Dealer' : 'Regular'} pricing`)
    } catch (error) {
      toast.error("Failed to update USSD price tier")
    } finally {
      setSavingUssdTier(false)
    }
  }

  const handleOrderingToggle = async (checked: boolean) => {
    setOrderingEnabled(checked)

    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      // Immediate partial update
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ ordering_enabled: checked }),
      })

      if (!response.ok) {
        throw new Error("Failed to update status")
      }

      toast.success(checked ? "Ordering Enabled" : "Ordering Paused")
    } catch (error) {
      console.error("Error updating ordering status:", error)
      toast.error("Failed to update status")
      setOrderingEnabled(!checked) // Revert on failure
    }
  }

  const handleStorefrontAnnouncementToggle = async (checked: boolean) => {
    setStorefrontAnnouncementEnabled(checked)

    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ storefront_announcement_enabled: checked }),
      })

      if (!response.ok) {
        throw new Error("Failed to update override status")
      }

      toast.success(checked ? "Global Override Enabled" : "Global Override Disabled")
    } catch (error) {
      console.error("Error toggling override:", error)
      toast.error("Failed to update status")
      setStorefrontAnnouncementEnabled(!checked) // Revert on failure
    }
  }

  const handleSave = async () => {
    // Relaxed validation: only warn if fields are actually touched but invalid
    const isUrl = (url: string) => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    };

    if (joinCommunityLink && !isUrl(joinCommunityLink)) {
      toast.error("Please enter a valid community link URL")
      return
    }

    setSaving(true)
    try {
      // Get session directly from Supabase
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()

      if (!session?.access_token) {
        toast.error("Authentication required. Please log in again.")
        setSaving(false)
        return
      }

      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          join_community_link: joinCommunityLink,
          ordering_enabled: orderingEnabled,
          announcement_enabled: announcementEnabled,
          announcement_title: announcementTitle,
          announcement_message: announcementMessage,
          storefront_announcement_enabled: storefrontAnnouncementEnabled,
          storefront_announcement_title: storefrontAnnouncementTitle,
          storefront_announcement_message: storefrontAnnouncementMessage,
          paystack_fee_percentage: paystackFeePercentage,
          wallet_topup_fee_percentage: walletTopupFeePercentage,
          withdrawal_fee_percentage: withdrawalFeePercentage,
          price_adjustment_mtn: priceAdjustmentMtn,
          price_adjustment_telecel: priceAdjustmentTelecel,
          price_adjustment_at_ishare: priceAdjustmentAtIshare,
          price_adjustment_at_bigtime: priceAdjustmentAtBigtime,
          signups_enabled: signupsEnabled,
          wallet_topups_enabled: walletTopupsEnabled,
          upgrades_enabled: upgradesEnabled,
          signup_default_role: signupDefaultRole,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        toast.error(result.error || "Failed to save settings")
        return
      }

      // Save support settings
      await supportSettingsService.updateSupportSettings(
        whatsappNumber,
        supportEmail,
        supportPhone,
        guestPurchaseUrl,
        guestPurchaseButtonText
      )

      toast.success("Settings saved successfully!")
    } catch (error) {
      console.error("[SETTINGS] Error saving settings:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to save settings"
      toast.error(errorMessage)
    } finally {
      setSaving(false)
    }
  }

  if (adminLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
      </div>
    )
  }

  return (
    <DashboardLayout>
      <div className="bg-gray-50 p-4 md:p-8">
        <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">App Settings</h1>
          <p className="text-gray-600 mt-2">
            Configure application-wide settings and community links
          </p>
        </div>

        {/* Global Ordering Control - Emergency Switch */}
        <Card className="mb-6 border-red-200 bg-red-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700">
              <Power className="w-5 h-5" />
              Global Ordering Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">
                  {orderingEnabled ? "Ordering is ENABLED" : "Ordering is DISABLED"}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {orderingEnabled
                    ? "Users can place orders normally."
                    : "ALL NEW ORDER PLACEMENT IS BLOCKED. Existing orders will continue to process."}
                </p>
              </div>
              <Switch
                checked={orderingEnabled}
                onCheckedChange={handleOrderingToggle}
                className="data-[state=checked]:bg-green-600 data-[state=unchecked]:bg-red-600"
              />
            </div>
          </CardContent>
        </Card>

        {/* Feature Availability Toggles */}
        <Card className="mb-6 border-blue-200 bg-blue-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-blue-800">
              <Power className="w-5 h-5" />
              Feature Availability Controls
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">Sign Ups</p>
                <p className="text-sm text-gray-600 mt-1">
                  Allow new users to register. If disabled, the sign-up form will block new registrations entirely.
                </p>
              </div>
              <Switch
                checked={signupsEnabled}
                onCheckedChange={setSignupsEnabled}
                className="data-[state=checked]:bg-green-600"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">Default Sign-Up Role</p>
                <p className="text-sm text-gray-600 mt-1">
                  Role automatically assigned to every new user at registration.
                </p>
              </div>
              <Select
                value={signupDefaultRole}
                onValueChange={(v) => setSignupDefaultRole(v as 'user' | 'dealer')}
                disabled={!signupsEnabled}
              >
                <SelectTrigger className="w-36 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="dealer">Dealer</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">Wallet Top Ups</p>
                <p className="text-sm text-gray-600 mt-1">
                  Allow users to add funds to their wallet. <br/>
                  <span className="text-blue-700 font-semibold text-xs">Admins bypass this restriction.</span>
                </p>
              </div>
              <Switch
                checked={walletTopupsEnabled}
                onCheckedChange={setWalletTopupsEnabled}
                className="data-[state=checked]:bg-green-600"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">Rank Upgrades</p>
                <p className="text-sm text-gray-600 mt-1">
                  Allow users to upgrade their subscription plans. <br/>
                  <span className="text-blue-700 font-semibold text-xs">Admins bypass this restriction.</span>
                </p>
              </div>
              <Switch
                checked={upgradesEnabled}
                onCheckedChange={setUpgradesEnabled}
                className="data-[state=checked]:bg-green-600"
              />
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700"
              >
                {saving ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
                ) : (
                  <><Save className="w-4 h-4" /> Save Controls</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Global Storefront Announcement Override - HIGH VISIBILITY */}
        <Card className="mb-6 border-violet-300 bg-violet-50/50 shadow-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-violet-800">
              <Megaphone className="w-5 h-5" />
              Global Storefront Announcement Override
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-violet-900 font-medium bg-white/60 p-3 rounded-lg border border-violet-100">
              ⚠️ Toggling this ON will force an override announcement to appear on ALL storefronts across the entire platform. This takes priority over individual shop announcements.
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-white border border-violet-200 rounded-lg shadow-sm">
              <div className="flex-1">
                <p className="font-bold text-gray-900">Enable Global Storefront Override</p>
                <p className="text-sm text-gray-600">Force this notice to ALL shop customers</p>
              </div>
              <Switch
                checked={storefrontAnnouncementEnabled}
                onCheckedChange={handleStorefrontAnnouncementToggle}
                className="data-[state=checked]:bg-green-600 data-[state=unchecked]:bg-gray-300 scale-125"
              />
            </div>

            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="storefrontAnnouncementTitle" className="text-sm font-bold text-violet-900">
                  Override Title
                </Label>
                <Input
                  id="storefrontAnnouncementTitle"
                  type="text"
                  placeholder="e.g. Platform-wide Alert"
                  value={storefrontAnnouncementTitle}
                  onChange={(e) => setStorefrontAnnouncementTitle(e.target.value)}
                  className="w-full bg-white border-violet-200 focus:ring-violet-500"
                  disabled={!storefrontAnnouncementEnabled}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="storefrontAnnouncementMessage" className="text-sm font-bold text-violet-900">
                  Override Message
                </Label>
                <Textarea
                  id="storefrontAnnouncementMessage"
                  placeholder="Enter the message customers will see on ALL shops..."
                  value={storefrontAnnouncementMessage}
                  onChange={(e) => setStorefrontAnnouncementMessage(e.target.value)}
                  className="w-full min-h-[100px] resize-y bg-white border-violet-200 focus:ring-violet-500"
                  disabled={!storefrontAnnouncementEnabled}
                />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="w-full sm:w-auto flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700 shadow-lg shadow-violet-100"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save & Apply Override
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <AirtimeSettingsCard />

        {/* USSD Settings */}
        <Card className="mb-6 border-green-200 bg-green-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-800">
              <Power className="w-5 h-5" />
              USSD Storefront Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-green-900">
              Configure pricing for the USSD self-service storefront (*code#).
            </p>
            <div className="space-y-2">
              <p className="font-medium text-gray-900 text-sm">Price Tier</p>
              <p className="text-xs text-gray-600">
                Dealer pricing uses <code>dealer_price</code> from each package. Falls back to regular price if dealer price is not set.
              </p>
              <div className="flex gap-3 mt-2">
                <button
                  onClick={() => handleUssdPriceTierChange("regular")}
                  disabled={savingUssdTier}
                  className={`flex-1 py-2 px-4 rounded-lg border-2 text-sm font-medium transition-colors ${
                    ussdPriceTier === "regular"
                      ? "border-green-600 bg-green-600 text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:border-green-400"
                  }`}
                >
                  Regular Price
                </button>
                <button
                  onClick={() => handleUssdPriceTierChange("dealer")}
                  disabled={savingUssdTier}
                  className={`flex-1 py-2 px-4 rounded-lg border-2 text-sm font-medium transition-colors ${
                    ussdPriceTier === "dealer"
                      ? "border-green-600 bg-green-600 text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:border-green-400"
                  }`}
                >
                  Dealer Price
                </button>
              </div>
              {savingUssdTier && (
                <p className="text-xs text-green-700 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Saving...
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ExternalLink className="w-5 h-5" />
              Join Community Link
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="joinLink" className="text-sm font-medium">
                Community Join Link
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                This link will be displayed to users who want to join your community
              </p>
              <Input
                id="joinLink"
                type="url"
                placeholder="https://discord.gg/..."
                value={joinCommunityLink}
                onChange={(e) => setJoinCommunityLink(e.target.value)}
                className="w-full"
              />
            </div>

            {joinCommunityLink && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm text-blue-700">
                  <span className="font-semibold">Preview:</span>{" "}
                  <a
                    href={joinCommunityLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline break-all"
                  >
                    {joinCommunityLink}
                  </a>
                </p>
              </div>
            )}

            <div className="flex gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-600" />
              Support Contact Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="whatsapp" className="text-sm font-medium">
                WhatsApp Number (Required)
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Used for password reset requests. Format: international without + (e.g., 233501234567)
              </p>
              <Input
                id="whatsapp"
                type="tel"
                placeholder="233501234567"
                value={whatsappNumber}
                onChange={(e) => handleWhatsappChange(e.target.value)}
                className="w-full"
              />
            </div>

            {previewWhatsappUrl && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs font-semibold text-green-900 mb-2">WhatsApp Link Preview:</p>
                <a
                  href={previewWhatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-green-600 hover:text-green-700 hover:underline break-all"
                >
                  Open WhatsApp Chat
                </a>
              </div>
            )}

            <div>
              <Label htmlFor="supportEmail" className="text-sm font-medium">
                Support Email (Optional)
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Shown as alternative contact method
              </p>
              <Input
                id="supportEmail"
                type="email"
                placeholder="support@example.com"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                className="w-full"
              />
            </div>

            <div>
              <Label htmlFor="supportPhone" className="text-sm font-medium">
                Support Phone (Optional)
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Local phone number format
              </p>
              <Input
                id="supportPhone"
                type="tel"
                placeholder="0501234567"
                value={supportPhone}
                onChange={(e) => setSupportPhone(e.target.value)}
                className="w-full"
              />
            </div>
          </CardContent>
        </Card>

        {/* Guest Purchase Configuration */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5 text-blue-600" />
              Guest Purchase Button
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              Configure the "Buy as Guest" button that appears on landing and login pages
            </p>

            <div>
              <Label htmlFor="guestPurchaseUrl" className="text-sm font-medium">
                Guest Purchase URL (Optional)
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                URL where guests can purchase without logging in. Leave empty to hide the button.
              </p>
              <Input
                id="guestPurchaseUrl"
                type="url"
                placeholder="https://shop.example.com/purchase"
                value={guestPurchaseUrl}
                onChange={(e) => setGuestPurchaseUrl(e.target.value)}
                className="w-full"
              />
            </div>

            <div>
              <Label htmlFor="guestPurchaseButtonText" className="text-sm font-medium">
                Button Text
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Text displayed on the guest purchase button
              </p>
              <Input
                id="guestPurchaseButtonText"
                type="text"
                placeholder="Buy as Guest"
                value={guestPurchaseButtonText}
                onChange={(e) => setGuestPurchaseButtonText(e.target.value)}
                className="w-full"
              />
            </div>

            {guestPurchaseUrl && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm font-medium text-blue-900 mb-2">Preview:</p>
                <Button variant="outline" type="button" className="pointer-events-none">
                  {guestPurchaseButtonText || "Buy as Guest"}
                </Button>
                <p className="text-xs text-blue-700 mt-2">
                  This button will appear on the landing page and login page, opening in a new window.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-green-600" />
              Payment Fees
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="paystackFee" className="text-sm font-medium">
                Paystack Fee Percentage
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Fee charged for Paystack payments (e.g., 3 for 3%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="paystackFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={paystackFeePercentage}
                  onChange={(e) => setPaystackFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="3.0"
                />
                <span className="text-sm font-medium text-gray-600">%</span>
              </div>
            </div>

            <div>
              <Label htmlFor="walletTopupFee" className="text-sm font-medium">
                Wallet Top-up Fee Percentage
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Additional fee charged on top-ups (e.g., 2 for 2%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="walletTopupFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={walletTopupFeePercentage}
                  onChange={(e) => setWalletTopupFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="0"
                />
                <span className="text-sm font-medium text-gray-600">%</span>
              </div>
            </div>

            <div>
              <Label htmlFor="withdrawalFee" className="text-sm font-medium">
                Withdrawal Fee Percentage
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Fee deducted from withdrawal requests (e.g., 5 for 5%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="withdrawalFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={withdrawalFeePercentage}
                  onChange={(e) => setWithdrawalFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="0"
                />
                <span className="text-sm font-medium text-gray-600">%</span>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
              <div>
                <h4 className="font-semibold text-sm text-blue-900 mb-2">Top-up Preview (GHS 100)</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-blue-700">Amount to top up:</span>
                    <span className="font-medium text-blue-900">GHS 100.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700">
                      Paystack fee ({paystackFeePercentage}%):
                    </span>
                    <span className="font-medium text-blue-900">
                      GHS {(100 * paystackFeePercentage / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700">
                      Wallet topup fee ({walletTopupFeePercentage}%):
                    </span>
                    <span className="font-medium text-blue-900">
                      GHS {(100 * walletTopupFeePercentage / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="border-t border-blue-200 pt-1 flex justify-between">
                    <span className="text-blue-900 font-semibold">Total charge:</span>
                    <span className="font-bold text-blue-900">
                      GHS {(100 + (100 * paystackFeePercentage / 100) + (100 * walletTopupFeePercentage / 100)).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="border-t border-blue-200 pt-3">
                <h4 className="font-semibold text-sm text-blue-900 mb-2">Withdrawal Preview (GHS 100 Requested)</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-blue-700">Requested amount:</span>
                    <span className="font-medium text-blue-900">GHS 100.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700">
                      Withdrawal fee ({withdrawalFeePercentage}%):
                    </span>
                    <span className="font-medium text-orange-600">
                      -GHS {(100 * withdrawalFeePercentage / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="border-t border-blue-200 pt-1 flex justify-between">
                    <span className="text-blue-900 font-semibold">Shop receives:</span>
                    <span className="font-bold text-green-600">
                      GHS {(100 - (100 * withdrawalFeePercentage / 100)).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Price Adjustment Settings */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-orange-600" />
              Package Price Adjustments
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              Adjust package prices by percentage for each network. Positive values increase prices (markup),
              negative values decrease prices (discount). Applied at display time without changing base prices.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* MTN */}
              <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <Label htmlFor="priceAdjMtn" className="text-sm font-medium text-yellow-900">
                  MTN Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjMtn"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentMtn}
                    onChange={(e) => setPriceAdjustmentMtn(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-yellow-800">%</span>
                </div>
                <p className="text-xs text-yellow-700 mt-1">
                  {priceAdjustmentMtn > 0 ? `+${priceAdjustmentMtn}% markup` : priceAdjustmentMtn < 0 ? `${priceAdjustmentMtn}% discount` : 'No adjustment'}
                </p>
              </div>

              {/* Telecel */}
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <Label htmlFor="priceAdjTelecel" className="text-sm font-medium text-red-900">
                  Telecel Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjTelecel"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentTelecel}
                    onChange={(e) => setPriceAdjustmentTelecel(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-red-800">%</span>
                </div>
                <p className="text-xs text-red-700 mt-1">
                  {priceAdjustmentTelecel > 0 ? `+${priceAdjustmentTelecel}% markup` : priceAdjustmentTelecel < 0 ? `${priceAdjustmentTelecel}% discount` : 'No adjustment'}
                </p>
              </div>

              {/* AT - iShare */}
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <Label htmlFor="priceAdjAtIshare" className="text-sm font-medium text-blue-900">
                  AT - iShare Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjAtIshare"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentAtIshare}
                    onChange={(e) => setPriceAdjustmentAtIshare(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-blue-800">%</span>
                </div>
                <p className="text-xs text-blue-700 mt-1">
                  {priceAdjustmentAtIshare > 0 ? `+${priceAdjustmentAtIshare}% markup` : priceAdjustmentAtIshare < 0 ? `${priceAdjustmentAtIshare}% discount` : 'No adjustment'}
                </p>
              </div>

              {/* AT - BigTime */}
              <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                <Label htmlFor="priceAdjAtBigtime" className="text-sm font-medium text-purple-900">
                  AT - BigTime Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjAtBigtime"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentAtBigtime}
                    onChange={(e) => setPriceAdjustmentAtBigtime(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-purple-800">%</span>
                </div>
                <p className="text-xs text-purple-700 mt-1">
                  {priceAdjustmentAtBigtime > 0 ? `+${priceAdjustmentAtBigtime}% markup` : priceAdjustmentAtBigtime < 0 ? `${priceAdjustmentAtBigtime}% discount` : 'No adjustment'}
                </p>
              </div>
            </div>

            {/* Preview */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mt-4">
              <h4 className="font-semibold text-sm text-gray-900 mb-3">Price Preview (GHS 10.00 base price)</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="text-center p-2 bg-yellow-100 rounded">
                  <p className="text-yellow-800 font-medium">MTN</p>
                  <p className="text-yellow-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentMtn / 100)).toFixed(2)}
                  </p>
                </div>
                <div className="text-center p-2 bg-red-100 rounded">
                  <p className="text-red-800 font-medium">Telecel</p>
                  <p className="text-red-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentTelecel / 100)).toFixed(2)}
                  </p>
                </div>
                <div className="text-center p-2 bg-blue-100 rounded">
                  <p className="text-blue-800 font-medium">AT-iShare</p>
                  <p className="text-blue-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentAtIshare / 100)).toFixed(2)}
                  </p>
                </div>
                <div className="text-center p-2 bg-purple-100 rounded">
                  <p className="text-purple-800 font-medium">AT-BigTime</p>
                  <p className="text-purple-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentAtBigtime / 100)).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5 text-purple-600" />
              Quick URL Copy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-600">
              Quick access to important application URLs. Click to copy any URL to clipboard.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {domainUrls.map((item) => (
                <div
                  key={item.url}
                  className="flex items-center justify-between gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{item.name}</p>
                    <p className="text-xs text-gray-500 truncate">{item.url}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(item.url)}
                    className="flex-shrink-0"
                  >
                    {copiedUrl === item.url ? (
                      <Check className="w-4 h-4 text-green-600" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5 text-purple-600" />
              Webhook URLs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-600">
              Configure these webhook URLs in your payment provider settings for real-time transaction updates.
            </p>
            <div className="space-y-3">
              <div className="p-4 border border-purple-200 bg-purple-50 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-900">Paystack Webhook</p>
                    <p className="text-xs text-gray-600 mt-1">Configure this in Paystack Dashboard → Settings → Webhooks</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => copyToClipboard(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/webhooks/paystack`)}
                    className="flex-shrink-0 ml-2"
                  >
                    {copiedUrl === `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/webhooks/paystack` ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <div className="p-2 bg-white rounded border border-purple-200">
                  <p className="text-xs text-gray-700 font-mono break-all">{`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/webhooks/paystack`}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>



        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-blue-600">
              <Bell className="w-5 h-5" />
              Login Announcement
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              This announcement is shown only to users when they log into their dashboard.
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex-1">
                <p className="font-medium text-gray-900">Enable Login Announcement</p>
                <p className="text-sm text-gray-600">Show modal upon sign in</p>
              </div>
              <Switch
                checked={announcementEnabled}
                onCheckedChange={setAnnouncementEnabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="announcementTitle" className="text-sm font-medium">
                Announcement Title
              </Label>
              <Input
                id="announcementTitle"
                type="text"
                placeholder="Important Announcement"
                value={announcementTitle}
                onChange={(e) => setAnnouncementTitle(e.target.value)}
                className="w-full"
                disabled={!announcementEnabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="announcementMessage" className="text-sm font-medium">
                Announcement Message
              </Label>
              <Textarea
                id="announcementMessage"
                placeholder="Enter your announcement message here..."
                value={announcementMessage}
                onChange={(e) => setAnnouncementMessage(e.target.value)}
                className="w-full min-h-[120px] resize-y"
                disabled={!announcementEnabled}
              />
            </div>

            {announcementEnabled && announcementTitle && announcementMessage && (
              <div className="p-3 sm:p-4 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs sm:text-sm text-green-700">
                  <span className="font-semibold">✓ Active:</span> This announcement will be shown to users upon sign in.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="w-full sm:w-auto flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Login Announcement
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Phone Blacklist Management */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-red-600" />
              Phone Number Blacklist
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PhoneBlacklistManager />
          </CardContent>
        </Card>

        {/* Checkout Phone-OTP Gate */}
        <Card className="mt-6 border-2 border-purple-500">
          <CardHeader className="bg-gradient-to-r from-purple-50 to-fuchsia-50">
            <CardTitle className="flex items-center gap-2 text-2xl">
              🔐 Checkout Phone Verification (OTP)
            </CardTitle>
            <CardDescription className="text-purple-800 mt-1">
              Require guests to verify their phone via SMS code before placing a
              shop order. Turn ON during an attack to stop automated orders / card-testing / payment-prompt abuse.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-purple-50 border-2 border-purple-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">Require Phone OTP at Checkout</p>
                <p className="text-sm text-gray-700 mt-2">
                  {checkoutOtpEnabled
                    ? "🔒 ON — every guest must enter an SMS code sent to their phone before they can place an order. Stops automated/bulk orders cold."
                    : "Guest checkout is open (no OTP). Enable this during an attack to force phone verification. Note: each checkout sends one SMS (cost), so keep it OFF in normal operation."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-4 min-w-fit">
                <span className={`text-sm font-bold ${checkoutOtpEnabled ? "text-green-700" : "text-gray-500"}`}>
                  {checkoutOtpEnabled ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={checkoutOtpEnabled}
                  onCheckedChange={handleCheckoutOtpToggle}
                  disabled={savingCheckoutOtp}
                  className="data-[state=checked]:bg-green-600"
                />
              </div>
            </div>

            {/* Storefront Direct MoMo Charge — independent of the OTP toggle */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-fuchsia-50 border-2 border-fuchsia-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">Direct MoMo Charge at Checkout</p>
                <p className="text-sm text-gray-700 mt-2">
                  {storefrontDirectCharge
                    ? "💸 ON — customers pay via an on-page Mobile Money prompt (no Paystack redirect), and the hosted MoMo channel is disabled so prompts can only reach the number entered on-page."
                    : "OFF — checkout sends customers to the hosted Paystack page (card/MoMo/bank). Turn ON for the on-page direct-charge experience."}
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Independent of the OTP toggle. With OTP ON the on-page number must be SMS-verified; with OTP OFF it's charged as typed (rate-capped).
                </p>
              </div>
              <div className="flex items-center justify-end gap-4 min-w-fit">
                <span className={`text-sm font-bold ${storefrontDirectCharge ? "text-green-700" : "text-gray-500"}`}>
                  {storefrontDirectCharge ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={storefrontDirectCharge}
                  onCheckedChange={handleStorefrontDirectToggle}
                  disabled={savingStorefrontDirect}
                  className="data-[state=checked]:bg-green-600"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Wallet & Upgrade Payment Protection */}
        <Card className="mt-6 border-2 border-blue-500">
          <CardHeader className="bg-gradient-to-r from-blue-50 to-cyan-50">
            <CardTitle className="flex items-center gap-2 text-2xl">
              💳 Wallet &amp; Upgrade Payment Protection
            </CardTitle>
            <CardDescription className="text-blue-800 mt-1">
              Locks down the <b>order-free</b> payment paths — wallet top-ups &amp; dealer
              upgrades — which otherwise let any signed-in account open a hosted
              checkout and fire Mobile Money prompts at any number. Independent of
              the checkout OTP gate. Turn ON during an attack.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-blue-50 border-2 border-blue-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">Protect Top-ups &amp; Upgrades</p>
                <p className="text-sm text-gray-700 mt-2">
                  {walletLockEnabled
                    ? "🔒 ON — top-ups/upgrades require an OTP-verified payment number. Prompt-spam via these paths is blocked."
                    : "OFF — no OTP required for top-ups/upgrades. Enable to require a verified payment number during an attack."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-4 min-w-fit">
                <span className={`text-sm font-bold ${walletLockEnabled ? "text-green-700" : "text-gray-500"}`}>
                  {walletLockEnabled ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={walletLockEnabled}
                  onCheckedChange={handleWalletLockToggle}
                  disabled={savingWalletLock}
                  className="data-[state=checked]:bg-green-600"
                />
              </div>
            </div>

            {/* Wallet/Upgrade Direct MoMo Charge — independent of the OTP toggle */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-cyan-50 border-2 border-cyan-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">Direct MoMo Charge for Top-ups &amp; Upgrades</p>
                <p className="text-sm text-gray-700 mt-2">
                  {walletDirectCharge
                    ? "💸 ON — top-ups/upgrades are paid via an on-page Mobile Money prompt, and the hosted MoMo channel is disabled (the WALLET- prompt-spam path)."
                    : "OFF — top-ups/upgrades use the hosted Paystack page (card/MoMo/bank). Turn ON for the on-page direct-charge experience."}
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Independent of the OTP toggle. With OTP ON the on-page number must be SMS-verified; with OTP OFF it's charged as typed (rate-capped).
                </p>
              </div>
              <div className="flex items-center justify-end gap-4 min-w-fit">
                <span className={`text-sm font-bold ${walletDirectCharge ? "text-green-700" : "text-gray-500"}`}>
                  {walletDirectCharge ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={walletDirectCharge}
                  onCheckedChange={handleWalletDirectToggle}
                  disabled={savingWalletDirect}
                  className="data-[state=checked]:bg-green-600"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Reset Phone Verifications */}
        <Card className="mt-6 border-2 border-red-500">
          <CardHeader className="bg-gradient-to-r from-red-50 to-rose-50">
            <CardTitle className="flex items-center gap-2 text-2xl">
              📵 Reset Phone Verifications
            </CardTitle>
            <CardDescription className="text-red-800 mt-1">
              Clears every OTP-verified number, so all customers must re-verify their
              payment number once on their next order. Use after an attack to wipe any
              numbers the attacker verified, or to force a clean slate.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-red-50 border-2 border-red-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">
                  {verifiedCount === null ? "Verified numbers" : `${verifiedCount} number${verifiedCount === 1 ? "" : "s"} currently verified`}
                </p>
                <p className="text-sm text-gray-700 mt-2">
                  Returning customers re-verify once (one SMS), then they're remembered again.
                  Takes effect immediately — no deploy needed. This cannot be undone.
                </p>
              </div>
              <div className="flex items-center justify-end min-w-fit">
                <Button
                  variant="destructive"
                  onClick={handleResetVerifications}
                  disabled={resettingVerifications}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {resettingVerifications ? "Resetting…" : "Reset all verifications"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Cloudflare Turnstile Kill Switch */}
        <Card className="mt-6 border-2 border-orange-500">
          <CardHeader className="bg-gradient-to-r from-orange-50 to-amber-50">
            <CardTitle className="flex items-center gap-2 text-2xl">
              🔒 Cloudflare Turnstile (CAPTCHA)
            </CardTitle>
            <CardDescription className="text-orange-800 mt-1">
              Master kill switch for the bot-protection CAPTCHA on shop orders.
              Only disable during an outage or when rotating the Turnstile secret.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-orange-50 border-2 border-orange-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">Turnstile Verification</p>
                <p className="text-sm text-gray-700 mt-2">
                  {turnstileEnabled
                    ? "✅ Turnstile is ACTIVE — every shop order POST must include a valid Cloudflare token. Bots get blocked at this layer."
                    : "⚠️ Turnstile is DISABLED — shop orders bypass CAPTCHA verification. Cookie + honeypot + atomic caps still apply, but bot-resistance is significantly weakened. Re-enable as soon as the incident is resolved."}
                </p>
                {!turnstileEnabled && (
                  <p className="text-xs font-bold text-red-700 mt-2">
                    🚨 Don't forget to re-enable this once the issue is fixed.
                  </p>
                )}
              </div>
              <div className="flex items-center justify-end gap-4 min-w-fit">
                <span className={`text-sm font-bold ${turnstileEnabled ? "text-green-700" : "text-red-700"}`}>
                  {turnstileEnabled ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={turnstileEnabled}
                  onCheckedChange={handleTurnstileToggle}
                  disabled={savingTurnstile}
                  className="data-[state=checked]:bg-green-600 data-[state=unchecked]:bg-red-500"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Christmas Theme Settings */}
        <Card className="mt-6 border-2 border-red-500">
          <CardHeader className="bg-gradient-to-r from-red-50 to-green-50">
            <CardTitle className="flex items-center gap-2 text-2xl">
              🎄 Christmas Theme 🎅
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-red-50 border-2 border-red-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">Enable Christmas Theme</p>
                <p className="text-sm text-gray-700 mt-2">
                  {christmasThemeEnabled
                    ? "✨ Christmas theme is currently ACTIVE! The app features festive colors, snowfall effects, and holiday decorations."
                    : "Add festive holiday spirit to the app with Christmas-themed colors, animations, and decorations."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-4 min-w-fit">
                <span className="text-sm font-medium text-gray-700">
                  {christmasThemeEnabled ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={christmasThemeEnabled}
                  onCheckedChange={handleChristmasThemeToggle}
                  disabled={savingChristmasTheme}
                />
                {savingChristmasTheme && (
                  <Loader2 className="h-5 w-5 animate-spin text-red-600" />
                )}
              </div>
            </div>

            <div className="p-4 bg-gradient-to-r from-red-100 to-green-100 border-2 border-green-400 rounded-lg">
              <p className="text-sm font-medium text-green-900">
                <span className="font-bold">🎁 Theme Features:</span> Red and green color scheme, snowfall animation, Christmas decorations (🎄 🎅 ⛄ 🎁 ❄️), festive button effects, and more!
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Terms of Service Editor */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-violet-600" />
              Terms of Service
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              This content appears on the public <strong>/terms</strong> page and inside shop "About" tabs.
            </p>

            {termsLastUpdated && (
              <p className="text-xs text-gray-400">
                Last updated: {new Date(termsLastUpdated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="termsContent" className="text-sm font-medium">
                Terms Content
              </Label>
              <p className="text-xs text-gray-500">
                Format: Start with an intro paragraph. Number sections like "1. Section Title" on their own line, followed by the section body.
              </p>
              <Textarea
                id="termsContent"
                value={termsContent}
                onChange={(e) => setTermsContent(e.target.value)}
                placeholder={`Welcome to DATAGOD. By accessing or using our platform, you agree to be bound by these Terms of Service.\n\n1. General Account Registration & Security\nBy creating an account on DATAGOD, you agree to provide accurate information...\n\n2. Instant, Non-Refundable Delivery\nAll digital products are processed and delivered instantly upon successful payment or Wallet deduction...`}
                className="min-h-[400px] resize-y font-mono text-sm"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                onClick={handleSaveTerms}
                disabled={savingTerms}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {savingTerms ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
                ) : (
                  <><Save className="w-4 h-4" /> Save Terms</>
                )}
              </Button>
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-violet-600 border border-violet-200 rounded-md hover:bg-violet-50 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Preview Public Page
              </a>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Settings Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-gray-700">
            <p>
              The join community link will be available to:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>Users viewing their dashboard</li>
              <li>Users in the sidebar or header</li>
              <li>Public pages (if configured)</li>
            </ul>
            <p className="text-gray-600 mt-4">
              Changes are saved immediately and reflected across the application.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
    </DashboardLayout>
  )
}
