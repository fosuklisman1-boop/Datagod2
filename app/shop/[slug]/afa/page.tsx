"use client"

import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Store, ChevronLeft, Loader2, AlertCircle, IdCard, ShieldCheck } from "lucide-react"
import { shopService } from "@/lib/shop-service"
import { useShopBasePath } from "@/lib/shop-url"
import { toast } from "sonner"

const REGIONS = [
  "Greater Accra", "Ashanti", "Central", "Eastern", "Northern", "Oti", "Savanna",
  "Upper East", "Upper West", "Volta", "Western", "Western North", "North East",
]

function formatGhanaCard(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 13)
  const letters = clean.slice(0, 3)
  const digits = clean.slice(3)
  if (!digits) return letters
  const firstGroup = digits.slice(0, 9)
  const lastDigit = digits.slice(9, 10)
  return lastDigit ? `${letters}-${firstGroup}-${lastDigit}` : `${letters}-${firstGroup}`
}

export default function ShopAfaPage() {
  const params = useParams()
  const shopSlug = params.slug as string
  const shopHome = useShopBasePath(shopSlug) || "/"

  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [fullName, setFullName] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [ghCardNumber, setGhCardNumber] = useState("")
  const [location, setLocation] = useState("")
  const [region, setRegion] = useState("")
  const [customerEmail, setCustomerEmail] = useState("")

  useEffect(() => {
    loadShop()
  }, [shopSlug])

  const loadShop = async () => {
    try {
      setLoading(true)
      const data = await shopService.getShopBySlug(shopSlug)
      if (!data) { toast.error("Shop not found"); return }
      setShop(data)
    } catch {
      toast.error("Failed to load shop details")
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!fullName.trim() || !phoneNumber.trim() || !ghCardNumber.trim() || !location.trim() || !region || !customerEmail.trim()) {
      toast.error("Please fill in all fields")
      return
    }
    try {
      setSubmitting(true)
      const res = await fetch("/api/shop/afa/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSlug,
          fullName: fullName.trim(),
          phoneNumber: phoneNumber.replace(/\s/g, ""),
          ghCardNumber,
          location: location.trim(),
          region,
          customerEmail: customerEmail.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start registration")
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl
      } else {
        throw new Error("No payment URL received")
      }
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40">
        <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4 text-center">
        <div>
          <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
          <p className="text-muted-foreground">Shop not found.</p>
        </div>
      </div>
    )
  }

  if (!shop.afa_price) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4 text-center">
        <div>
          <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
          <p className="text-muted-foreground">AFA registration isn't available from this shop right now.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted/40 pb-10">
      <div className="max-w-md mx-auto px-4 pt-6">
        <a href={shopHome} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ChevronLeft className="w-4 h-4" /> Back to {shop.shop_name}
        </a>

        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]"><IdCard className="h-4 w-4" /></span>
            <h1 className="text-lg font-bold text-foreground">AFA Registration</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-4">Register for the government AFA scheme through {shop.shop_name}.</p>

          <div className="rounded-2xl bg-[#1b388b]/5 border border-[#1b388b]/20 p-3 mb-4">
            <p className="text-xs text-muted-foreground">Registration Fee</p>
            <p className="text-2xl font-black text-foreground">GH₵{Number(shop.afa_price).toFixed(2)}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <Label htmlFor="fullName">Full Name *</Label>
              <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="As it appears on your Ghana Card" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="ghCard">Ghana Card Number *</Label>
              <Input id="ghCard" value={ghCardNumber} onChange={(e) => setGhCardNumber(formatGhanaCard(e.target.value))} placeholder="GHA-123456789-0" className="mt-1 font-mono" />
            </div>
            <div>
              <Label htmlFor="phone">Phone Number *</Label>
              <Input id="phone" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="0541234567" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="location">Location *</Label>
              <Input id="location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Madina, Accra" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="region">Region *</Label>
              <select id="region" value={region} onChange={(e) => setRegion(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm">
                <option value="">Select region</option>
                {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="email">Email (for payment receipt) *</Label>
              <Input id="email" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="you@example.com" className="mt-1" />
            </div>

            <Button type="submit" disabled={submitting} className="w-full h-12 rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90 font-bold">
              {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Pay GH₵{Number(shop.afa_price).toFixed(2)} & Register
            </Button>

            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground pt-1">
              <ShieldCheck className="w-3.5 h-3.5" /> Secured by Paystack
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
