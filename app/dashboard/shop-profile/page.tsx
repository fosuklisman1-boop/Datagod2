"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { shopService } from "@/lib/shop-service"
import { supabase } from "@/lib/supabase"
import { shopOrigin } from "@/lib/shop-url"
import { PillToggle } from "@/components/shop/pill-toggle"
import {
  Store, CheckCircle2, Loader2, Phone, Mail, Users2, Palette, MessageSquare,
  Smartphone, Upload, RefreshCw, AlertTriangle, ExternalLink, ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"

const STEPS = [
  { n: 1, label: "Details" },
  { n: 2, label: "Contact" },
  { n: 3, label: "Community" },
  { n: 4, label: "Branding" },
  { n: 5, label: "SMS" },
  { n: 6, label: "USSD" },
] as const

const COLOR_PRESETS = [
  { name: "Gold", hex: "#eab308" },
  { name: "Green", hex: "#22c55e" },
  { name: "Red", hex: "#ef4444" },
  { name: "Ocean Blue", hex: "#2563eb" },
  { name: "Emerald", hex: "#10b981" },
  { name: "Purple", hex: "#a855f7" },
  { name: "Orange", hex: "#f97316" },
  { name: "Rose", hex: "#f43f5e" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Slate", hex: "#475569" },
  { name: "Amber", hex: "#d97706" },
]

export default function ShopProfilePage() {
  const { user } = useAuth()
  const router = useRouter()

  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(1)
  const [completed, setCompleted] = useState<Set<number>>(new Set())

  // Step 1: Details
  const [shopName, setShopName] = useState("")
  const [description, setDescription] = useState("")
  const [logoUrl, setLogoUrl] = useState("")
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [newSlug, setNewSlug] = useState("")
  const [rotatingSlug, setRotatingSlug] = useState(false)
  const [showSlugChange, setShowSlugChange] = useState(false)

  // Step 2: Contact
  const [whatsappLink, setWhatsappLink] = useState("")

  // Step 3: Community
  const [communityLink, setCommunityLink] = useState("")

  // Step 4: Branding — storefront hero is a two-color gradient card
  const [customColor, setCustomColor] = useState("")
  const [customColor2, setCustomColor2] = useState("")

  // Step 5: SMS
  const [orderSmsEnabled, setOrderSmsEnabled] = useState(true)
  const [smsAccount, setSmsAccount] = useState<any>(null)
  const [walletBalance, setWalletBalance] = useState(0)
  const [activating, setActivating] = useState(false)
  const [payFrom, setPayFrom] = useState<"wallet" | "paystack">("wallet")

  // Danger zone
  const [confirmName, setConfirmName] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    if (!user) return
    loadAll()
  }, [user])

  const authedFetch = async (url: string, init?: RequestInit) => {
    const { data: { session } } = await supabase.auth.getSession()
    return fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        ...(init?.headers || {}),
      },
    })
  }

  const loadAll = async () => {
    try {
      setLoading(true)
      if (!user?.id) return
      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      if (!userShop) return

      setShopName(userShop.shop_name || "")
      setDescription(userShop.description || "")
      setLogoUrl(userShop.logo_url || "")
      setCustomColor(userShop.custom_color || "")
      setCustomColor2(userShop.custom_color_2 || "")

      const [settingsRes, smsRes, walletRes] = await Promise.all([
        fetch(`/api/shop/settings/${userShop.id}`).then((r) => r.json()).catch(() => null),
        authedFetch("/api/sms/account").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        authedFetch("/api/wallet/balance").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])

      if (settingsRes) {
        setWhatsappLink(settingsRes.whatsapp_link || "")
        setCommunityLink(settingsRes.community_link || "")
        setOrderSmsEnabled(settingsRes.order_confirmation_sms_enabled !== false)
      }
      if (smsRes?.account) setSmsAccount(smsRes.account)
      if (walletRes) setWalletBalance(walletRes.balance || 0)
    } catch (error) {
      console.error("Error loading shop profile:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load shop profile")
    } finally {
      setLoading(false)
    }
  }

  const markComplete = (n: number) => setCompleted((prev) => new Set(prev).add(n))

  const handleLogoUpload = async (file: File) => {
    if (!shop?.id) return
    setUploadingLogo(true)
    try {
      const path = `shop-logos/${shop.id}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`
      const { error: uploadError } = await supabase.storage.from("admin-uploads").upload(path, file, { upsert: true })
      if (uploadError) throw uploadError
      const { data } = supabase.storage.from("admin-uploads").getPublicUrl(path)
      setLogoUrl(data.publicUrl)
      toast.success("Logo uploaded")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Logo upload failed")
    } finally {
      setUploadingLogo(false)
    }
  }

  const saveShopFields = async (updates: Record<string, any>) => {
    const res = await authedFetch("/api/shop/manage", {
      method: "POST",
      body: JSON.stringify({ action: "update_shop", shopId: shop.id, updates }),
    })
    const result = await res.json()
    if (!res.ok) throw new Error(result?.error || "Failed to save")
    return result.shop
  }

  const saveSettingsFields = async (updates: Record<string, any>) => {
    const res = await authedFetch(`/api/shop/settings/${shop.id}`, { method: "PUT", body: JSON.stringify(updates) })
    const result = await res.json()
    if (!res.ok) throw new Error(result?.error || "Failed to save")
    return result.settings
  }

  const handleRotateSlug = async () => {
    if (!shop?.id) return
    setRotatingSlug(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await authedFetch(`/api/dashboard/shops/${shop.id}/rotate-slug`, {
        method: "POST",
        body: JSON.stringify(newSlug.trim() ? { newSlug: newSlug.trim() } : {}),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result?.error || "Failed to change URL")
      setShop((prev: any) => ({ ...prev, shop_slug: result.newSlug }))
      setNewSlug("")
      setShowSlugChange(false)
      toast.success(`Shop URL changed. Old links will redirect automatically — share the new one with customers.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change URL")
    } finally {
      setRotatingSlug(false)
    }
  }

  const handleContinue = async () => {
    if (!shop?.id) return
    setSaving(true)
    try {
      if (step === 1) {
        if (!shopName.trim()) { toast.error("Shop name is required"); setSaving(false); return }
        await saveShopFields({ shop_name: shopName.trim(), description: description.trim(), logo_url: logoUrl || null })
      } else if (step === 2) {
        await saveSettingsFields({ whatsapp_link: whatsappLink.trim() })
      } else if (step === 3) {
        await saveSettingsFields({ community_link: communityLink.trim() })
      } else if (step === 4) {
        await saveShopFields({ logo_url: logoUrl || null, custom_color: customColor || null, custom_color_2: customColor2 || null })
        setShop((prev: any) => ({ ...prev, custom_color: customColor || null, custom_color_2: customColor2 || null, logo_url: logoUrl || null }))
      } else if (step === 5) {
        await saveSettingsFields({ order_confirmation_sms_enabled: orderSmsEnabled })
      }
      markComplete(step)
      toast.success("Saved")
      if (step < 6) setStep(step + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleActivateSms = async () => {
    if (!smsAccount) return
    setActivating(true)
    try {
      const res = await authedFetch("/api/sms/activate", { method: "POST", body: JSON.stringify({ paidFrom: payFrom }) })
      const result = await res.json()
      if (!res.ok) throw new Error(result?.error || "Failed to activate SMS")
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl
        return
      }
      toast.success("SMS account activated")
      const refreshed = await authedFetch("/api/sms/account").then((r) => r.json()).catch(() => null)
      if (refreshed?.account) setSmsAccount(refreshed.account)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to activate SMS")
    } finally {
      setActivating(false)
    }
  }

  const handleStartOver = () => {
    setStep(1)
    setCompleted(new Set())
  }

  const handleDelete = async () => {
    if (!shop?.id) return
    setDeleting(true)
    try {
      const res = await authedFetch("/api/shop/delete", {
        method: "POST",
        body: JSON.stringify({ shopId: shop.id, confirmName }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result?.error || "Failed to delete shop")
      toast.success("Shop deleted")
      router.push("/dashboard")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete shop")
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <RefreshCw className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  if (!shop) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl space-y-4 text-center py-12">
          <Store className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">You don't have a shop yet.</p>
          <Link href="/dashboard/my-shop" className="inline-block rounded-xl bg-[#1b388b] px-5 py-2.5 text-sm font-bold text-white">Create your shop</Link>
        </div>
      </DashboardLayout>
    )
  }

  const smsInactive = !smsAccount || smsAccount.status !== "active"
  const activationFee = smsAccount?.activationFee ?? 0
  const canAffordWallet = walletBalance >= activationFee

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-3xl space-y-5">
        <DashboardHeroBanner backHref="/dashboard/my-shop" title="Shop Setup Wizard" subtitle={`Let's get your ${shop.shop_name} storefront ready.`} icon={Store} />

        {completed.size > 0 && (
          <button onClick={handleStartOver} className="text-xs font-semibold text-muted-foreground underline">Start over</button>
        )}

        {/* Step pills */}
        <div className="flex flex-wrap gap-1.5">
          {STEPS.map((s) => (
            <button
              key={s.n}
              onClick={() => setStep(s.n)}
              className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold transition ${
                step === s.n ? "bg-[#1b388b] text-white" : completed.has(s.n) ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
              }`}
            >
              {completed.has(s.n) && <CheckCircle2 className="h-3 w-3" />}
              {s.n}. {s.label}
            </button>
          ))}
        </div>

        {/* Step content */}
        <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
          {step === 1 && (
            <>
              <p className="flex items-center gap-2 text-base font-bold text-foreground"><Store className="h-4 w-4 text-[#1b388b]" /> Shop Details</p>

              <div>
                <label className="mb-1 block text-sm font-semibold text-foreground">Shop Name *</label>
                <input value={shopName} onChange={(e) => setShopName(e.target.value)} className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none" />
                <p className="mt-1 text-xs text-muted-foreground">This will be the browser title on your shop page.</p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-foreground">Shop Logo</label>
                <div className="flex items-center gap-3">
                  {logoUrl && <img src={logoUrl} alt="Shop logo" className="h-12 w-12 rounded-lg border border-border object-cover" />}
                  <label className="flex-1 cursor-pointer rounded-xl border-2 border-dashed border-border px-4 py-3 text-center text-sm text-muted-foreground hover:border-[#1b388b]">
                    {uploadingLogo ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : <span className="flex items-center justify-center gap-1.5"><Upload className="h-3.5 w-3.5" /> {logoUrl ? "Change logo" : "Click to upload logo"}</span>}
                    <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && handleLogoUpload(e.target.files[0])} />
                  </label>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">JPG, PNG, WEBP up to 5MB.</p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-foreground">Shop URL</label>
                <p className="break-all rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                  {shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `datagod.store/shop/${shop.shop_slug}`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Your main storefront address — fixed, cannot be changed here.</p>

                <div className="mt-3 border-t border-border pt-3">
                  <p className="text-xs font-semibold text-foreground">Legacy link alias: datagod.store/shop/{shop.shop_slug}</p>
                  <p className="text-xs text-muted-foreground">Rotate this if it's ever leaked or being abused — old links redirect automatically, but customers who saved it will need the new one from you.</p>
                  {!showSlugChange ? (
                    <button onClick={() => setShowSlugChange(true)} className="mt-1 text-xs font-semibold text-[#1b388b] underline">Rotate alias link</button>
                  ) : (
                    <div className="mt-2 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                      <div className="flex gap-2">
                        <input value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder="Leave blank to auto-generate" className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground focus:outline-none" />
                        <button onClick={handleRotateSlug} disabled={rotatingSlug} className="rounded-lg bg-[#1b388b] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
                          {rotatingSlug ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-sm font-semibold text-foreground">Description</label>
                  <span className="text-xs text-muted-foreground">{description.length}/400</span>
                </div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 400))}
                  placeholder="Describe your shop (shown as subtitle and meta description)"
                  rows={3}
                  className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                />
              </div>

              <div className="rounded-2xl border border-border bg-muted/30 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-foreground">Shop Status</p>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${shop.is_active ? "bg-success/10 text-success" : "bg-amber-500/10 text-amber-600"}`}>
                    {shop.is_active ? "LIVE" : "PENDING APPROVAL"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {shop.is_active
                    ? "Your shop is live and visible to customers."
                    : "New shops are reviewed by an admin before going live. This usually happens quickly after you finish setup."}
                </p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="flex items-center gap-2 text-base font-bold text-foreground"><Phone className="h-4 w-4 text-[#1b388b]" /> Contact Information</p>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground"><MessageSquare className="h-3.5 w-3.5" /> WhatsApp Link</label>
                <input
                  value={whatsappLink}
                  onChange={(e) => setWhatsappLink(e.target.value)}
                  placeholder="https://wa.me/233244123456 or 0244123456"
                  className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                />
                <p className="mt-1 text-xs text-muted-foreground">Shown as a "Contact on WhatsApp" button on your storefront.</p>
              </div>
              <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <Mail className="mb-1 inline h-3.5 w-3.5" /> Your account email and phone are managed from your Profile page, not per-shop.
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="flex items-center gap-2 text-base font-bold text-foreground"><Users2 className="h-4 w-4 text-[#1b388b]" /> Community Link (Optional)</p>
              <div>
                <label className="mb-1 block text-sm font-semibold text-foreground">Community / Group Link</label>
                <input
                  value={communityLink}
                  onChange={(e) => setCommunityLink(e.target.value)}
                  placeholder="https://chat.whatsapp.com/... or https://t.me/..."
                  className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                />
                <p className="mt-1 text-xs text-muted-foreground">Share your WhatsApp group, Telegram channel, or any community link — shown as a "Join our community" button on your storefront.</p>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className="flex items-center gap-2 text-base font-bold text-foreground"><Palette className="h-4 w-4 text-[#1b388b]" /> Branding</p>

              <div>
                <label className="mb-1 block text-sm font-semibold text-foreground">Shop Logo</label>
                <div className="flex items-center gap-3">
                  {logoUrl && <img src={logoUrl} alt="Shop logo" className="h-12 w-12 rounded-lg border border-border object-cover" />}
                  <label className="flex-1 cursor-pointer rounded-xl border-2 border-dashed border-border px-4 py-3 text-center text-sm text-muted-foreground hover:border-[#1b388b]">
                    {uploadingLogo ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : <span className="flex items-center justify-center gap-1.5"><Upload className="h-3.5 w-3.5" /> {logoUrl ? "Change logo" : "Click to upload logo"}</span>}
                    <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && handleLogoUpload(e.target.files[0])} />
                  </label>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-foreground">Brand Color</label>
                <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
                  {COLOR_PRESETS.map((c) => (
                    <button
                      key={c.name}
                      onClick={() => setCustomColor(c.hex)}
                      className={`flex flex-col items-center gap-1 rounded-xl border-2 p-2 text-[10px] font-semibold text-muted-foreground ${customColor === c.hex ? "border-[#1b388b]" : "border-transparent"}`}
                    >
                      <span className="h-8 w-8 rounded-full" style={{ backgroundColor: c.hex }} />
                      {c.name}
                    </button>
                  ))}
                  <button
                    onClick={() => setCustomColor("")}
                    className={`flex flex-col items-center gap-1 rounded-xl border-2 p-2 text-[10px] font-semibold text-muted-foreground ${!customColor ? "border-[#1b388b]" : "border-transparent"}`}
                  >
                    <span className="grid h-8 w-8 place-items-center rounded-full border border-dashed border-border text-[9px]">None</span>
                    Default
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Custom color:</span>
                  <input type="color" value={customColor || "#1b388b"} onChange={(e) => setCustomColor(e.target.value)} className="h-8 w-8 cursor-pointer rounded border border-border" />
                  <span className="text-xs text-muted-foreground">{customColor || "not set"}</span>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-foreground">Secondary Color</label>
                <p className="mb-2 text-xs text-muted-foreground">Your storefront's hero banner blends from the primary color into this one.</p>
                <div className="flex items-center gap-2">
                  <input type="color" value={customColor2 || customColor || "#1b388b"} onChange={(e) => setCustomColor2(e.target.value)} className="h-8 w-8 cursor-pointer rounded border border-border" />
                  <span className="text-xs text-muted-foreground">{customColor2 || "not set"}</span>
                  {customColor2 && (
                    <button onClick={() => setCustomColor2("")} className="text-xs font-semibold text-[#1b388b] hover:underline">Clear</button>
                  )}
                </div>
              </div>

              {(customColor || customColor2) && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-muted-foreground"><ExternalLink className="h-3 w-3" /> Preview</p>
                  <div
                    className="relative overflow-hidden rounded-2xl p-6 text-center"
                    style={{ backgroundImage: `linear-gradient(135deg, ${customColor || "#1b388b"}, ${customColor2 || customColor || "#1b388b"})` }}
                  >
                    <span className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
                    <span className="pointer-events-none absolute -bottom-8 left-10 h-24 w-24 rounded-full bg-white/5 blur-xl" />
                    <Store className="relative mx-auto mb-1 h-6 w-6 text-white" />
                    <p className="relative font-bold text-white">{shopName || "Your Shop"}</p>
                    <p className="relative text-xs text-white/80">{description || "Your shop description appears here."}</p>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 5 && (
            <>
              <p className="flex items-center gap-2 text-base font-bold text-foreground"><MessageSquare className="h-4 w-4 text-[#1b388b]" /> SMS Notifications</p>

              <div className="flex items-center justify-between rounded-xl border border-border p-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Order confirmation texts</p>
                  <p className="text-xs text-muted-foreground">Automatically text your customers when their order is confirmed. Free — no activation needed.</p>
                </div>
                <PillToggle checked={orderSmsEnabled} onChange={() => setOrderSmsEnabled((v) => !v)} activeColor="bg-success" />
              </div>

              <div className="rounded-2xl border border-border bg-muted/30 p-4 space-y-3">
                <div>
                  <p className="text-sm font-bold text-foreground">Bulk SMS Account</p>
                  <p className="text-xs text-muted-foreground">Activate to send your own marketing/broadcast SMS campaigns to customers from /dashboard/sms.</p>
                </div>
                {smsInactive ? (
                  <>
                    <p className="text-xs text-foreground">One-time activation fee: <span className="font-bold">GHS {activationFee.toFixed(2)}</span></p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setPayFrom("wallet")}
                        className={`rounded-xl border-2 px-3 py-2.5 text-xs font-bold ${payFrom === "wallet" ? "border-success bg-success/5 text-success" : "border-border text-muted-foreground"}`}
                      >
                        Wallet (GHS {walletBalance.toFixed(2)})
                      </button>
                      <button
                        onClick={() => setPayFrom("paystack")}
                        className={`rounded-xl border-2 px-3 py-2.5 text-xs font-bold ${payFrom === "paystack" ? "border-success bg-success/5 text-success" : "border-border text-muted-foreground"}`}
                      >
                        Pay with MoMo/Card
                      </button>
                    </div>
                    {payFrom === "wallet" && !canAffordWallet && (
                      <p className="text-xs text-destructive">Insufficient wallet balance. Top up or pay with MoMo/Card instead.</p>
                    )}
                    <button
                      onClick={handleActivateSms}
                      disabled={activating || (payFrom === "wallet" && !canAffordWallet)}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1b388b] py-3 text-sm font-bold text-white disabled:opacity-40"
                    >
                      {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Enable SMS
                    </button>
                  </>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" /> Activated — {smsAccount.unitBalance} units available</p>
                )}
                <Link href="/dashboard/sms" className="block text-xs font-semibold text-[#1b388b] underline">Configure templates & sender ID →</Link>
              </div>
            </>
          )}

          {step === 6 && (
            <>
              <p className="flex items-center gap-2 text-base font-bold text-foreground"><Smartphone className="h-4 w-4 text-[#1b388b]" /> USSD Shortcode</p>
              <p className="text-sm text-muted-foreground">Give customers a USSD code to order without an app or internet. Optional — you can enable this any time from your dashboard once your shop is live.</p>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700">
                {shop.is_active ? (
                  <>Your shop is live — head to <Link href="/dashboard/ussd-shop" className="font-semibold underline">USSD settings</Link> to activate.</>
                ) : (
                  <>Your shop needs to be live first — finish this wizard and wait for admin approval, then come back here (or visit <Link href="/dashboard/ussd-shop" className="font-semibold underline">USSD settings</Link>) to activate.</>
                )}
              </div>
            </>
          )}
        </div>

        {/* Nav buttons */}
        <div className="flex items-center justify-between gap-3">
          {step > 1 ? (
            <button onClick={() => setStep(step - 1)} className="rounded-xl border border-border px-5 py-3 text-sm font-bold text-foreground">← Back</button>
          ) : <span />}
          <button
            onClick={handleContinue}
            disabled={saving}
            className="rounded-xl bg-[#1b388b] px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : step === 6 ? "Save Changes" : "Continue"}
          </button>
        </div>

        {/* Danger zone */}
        <div className="space-y-2 pt-4">
          <p className="flex items-center gap-1.5 text-sm font-bold text-destructive"><AlertTriangle className="h-4 w-4" /> Danger Zone</p>
          <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-bold text-foreground">Delete Shop</p>
              <p className="text-xs text-muted-foreground">Permanently delete your shop, data bundle orders, and shop wallet. This action cannot be undone. Blocked while you have an unwithdrawn balance or a withdrawal in progress.</p>
            </div>
            <button onClick={() => setShowDeleteConfirm(true)} className="flex-shrink-0 rounded-xl bg-destructive px-4 py-2.5 text-sm font-bold text-white">Delete Shop</button>
          </div>
        </div>

        {showDeleteConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowDeleteConfirm(false)}>
            <div className="w-full max-w-sm rounded-2xl bg-card p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
              <p className="flex items-center gap-2 text-base font-bold text-destructive"><ShieldCheck className="h-4 w-4" /> Confirm Deletion</p>
              <p className="text-sm text-muted-foreground">Type <span className="font-bold text-foreground">{shop.shop_name}</span> to confirm. This cannot be undone.</p>
              <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:outline-none" />
              <div className="flex gap-2">
                <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-bold text-foreground">Cancel</button>
                <button
                  onClick={handleDelete}
                  disabled={deleting || confirmName.trim().toLowerCase() !== shop.shop_name.trim().toLowerCase()}
                  className="flex-1 rounded-xl bg-destructive py-2.5 text-sm font-bold text-white disabled:opacity-40"
                >
                  {deleting ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : "Delete Forever"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
