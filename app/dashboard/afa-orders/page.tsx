"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Wallet, Zap, ShieldCheck, Loader2, User, ClipboardPaste, X, Send, BarChart3, UserPlus, History as HistoryIcon,
} from "lucide-react"
import { toast } from "sonner"
import { formatGhanaCardInput, parseGhanaCardNumber } from "@/lib/ghana-card"

interface AFAOrder {
  id: string
  order_code: string
  transaction_code?: string
  full_name?: string
  phone_number?: string
  gh_card_number?: string
  location?: string
  region?: string
  occupation?: string
  amount: number
  status: "pending" | "processing" | "completed" | "cancelled"
  created_at: string
}

interface Stats {
  total: number
  pending: number
  processing: number
  completed: number
  cancelled: number
  totalSpent: number
}

const REGIONS = [
  "Greater Accra", "Ashanti", "Central", "Eastern", "Northern", "Oti", "Savanna",
  "Upper East", "Upper West", "Volta", "Western", "Western North", "North East",
]

const STATUS_TILES: { key: keyof Stats; label: string; bg: string; fg: string }[] = [
  { key: "total", label: "Total Registered", bg: "bg-[#1b388b]/10", fg: "text-[#1b388b]" },
  { key: "pending", label: "Pending", bg: "bg-warning/10", fg: "text-warning" },
  { key: "processing", label: "Processing", bg: "bg-[#1b388b]/10", fg: "text-[#1b388b]" },
  { key: "completed", label: "Completed", bg: "bg-success/10", fg: "text-success" },
  { key: "cancelled", label: "Cancelled", bg: "bg-destructive/10", fg: "text-destructive" },
]

const STATUS_BADGE: Record<string, string> = {
  completed: "bg-success/15 text-success",
  pending: "bg-warning/10 text-warning",
  processing: "bg-[#1b388b]/10 text-[#1b388b]",
  cancelled: "bg-destructive/15 text-destructive",
}

const TABS = [
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "new", label: "New", icon: UserPlus },
  { id: "history", label: "History", icon: HistoryIcon },
] as const

export default function AFAOrdersPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [tab, setTab] = useState<"stats" | "new" | "history">("new")
  const [orders, setOrders] = useState<AFAOrder[]>([])
  const [stats, setStats] = useState<Stats>({ total: 0, pending: 0, processing: 0, completed: 0, cancelled: 0, totalSpent: 0 })
  const [loading, setLoading] = useState(true)

  // Form
  const [fullName, setFullName] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [ghCardNumber, setGhCardNumber] = useState("")
  const [location, setLocation] = useState("")
  const [region, setRegion] = useState("")
  const [myPhone, setMyPhone] = useState<string | null>(null)
  const [walletBalance, setWalletBalance] = useState(0)
  const [afaPrice, setAfaPrice] = useState(50)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user && !authLoading) {
      loadOrders()
      loadFormContext()
    }
  }, [user, authLoading])

  const loadFormContext = async () => {
    if (!user) return
    try {
      const [{ data: profile }, priceRes, { data: { session } }] = await Promise.all([
        supabase.from("users").select("phone_number").eq("id", user.id).single(),
        fetch("/api/afa/price"),
        supabase.auth.getSession(),
      ])
      if (profile?.phone_number) setMyPhone(profile.phone_number)
      if (priceRes.ok) {
        const priceData = await priceRes.json()
        setAfaPrice(priceData.price || 50)
      }
      if (session?.access_token) {
        const balRes = await fetch("/api/wallet/balance", { headers: { Authorization: `Bearer ${session.access_token}` } })
        if (balRes.ok) {
          const balData = await balRes.json()
          setWalletBalance(balData.balance || 0)
        }
      }
    } catch (error) {
      console.error("[AFA-ORDERS] Error loading form context:", error)
    }
  }

  const loadOrders = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }
      const response = await fetch("/api/user/afa-orders", { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (!response.ok) throw new Error("Failed to fetch orders")
      const data = await response.json()
      setOrders(data.orders || [])
      setStats(data.stats || { total: 0, pending: 0, processing: 0, completed: 0, cancelled: 0, totalSpent: 0 })
    } catch (error) {
      console.error("[AFA-ORDERS] Error loading orders:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load AFA orders")
    } finally {
      setLoading(false)
    }
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      setPhoneNumber(text.replace(/\D/g, "").slice(0, 10))
    } catch {
      toast.error("Couldn't read clipboard — paste manually instead")
    }
  }

  const hasSufficientBalance = walletBalance >= afaPrice
  const isFormValid = fullName.trim() && phoneNumber.trim() && ghCardNumber.trim() && location.trim() && region.trim()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isFormValid) {
      toast.error("Please fill in every field")
      return
    }
    if (!hasSufficientBalance) {
      toast.error(`Insufficient balance. Required: GHS ${afaPrice.toFixed(2)}, Available: GHS ${walletBalance.toFixed(2)}`)
      return
    }
    const normalizedGhCard = parseGhanaCardNumber(ghCardNumber)
    if (!normalizedGhCard) {
      toast.error("Ghana Card number must be in the format GHA-123456789-0")
      return
    }
    setSubmitting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session")

      const response = await fetch("/api/afa/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          fullName: fullName.trim(),
          phoneNumber: phoneNumber.trim(),
          ghCardNumber: normalizedGhCard,
          location: location.trim(),
          region: region.trim(),
          occupation: "Farmer", // fixed value -- was already a disabled, non-editable field
          amount: afaPrice,
          userId: user!.id,
        }),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || "Failed to submit AFA order")
      }
      toast.success("AFA registration submitted successfully!")
      setFullName(""); setPhoneNumber(""); setGhCardNumber(""); setLocation(""); setRegion("")
      loadOrders()
      loadFormContext()
    } catch (error) {
      console.error("[AFA-ORDERS] Submit error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to submit AFA order")
    } finally {
      setSubmitting(false)
    }
  }

  if (authLoading || !user || loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl lg:max-w-4xl mx-auto space-y-5">
        <DashboardHeroBanner title="MTN AFA Registration" subtitle="Register a beneficiary for the MTN AFA package." icon={UserPlus} />

        {/* Tabs */}
        <div className="inline-flex w-full rounded-2xl bg-muted p-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition ${
                tab === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {tab === "new" && (
        <>
        {/* Wallet Cash -- real fee + real balance, "Auto-Deduct" is accurate:
            payment is deducted from the wallet server-side on submit. */}
        <div className="rounded-2xl border-2 border-[#1b388b] bg-[#1b388b]/5 p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-bold text-[#1b388b]">
              <Wallet className="h-4 w-4" /> Wallet Cash
            </span>
            <span className="flex items-center gap-1 rounded-full bg-[#1b388b]/10 px-2.5 py-1 text-[11px] font-bold text-[#1b388b]">
              <Zap className="h-3 w-3" /> Auto-Deduct
            </span>
          </div>
          <p className="mt-2 text-2xl font-black text-foreground">GHS {afaPrice.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Bal: GHS {walletBalance.toFixed(2)}</p>
          {!hasSufficientBalance && (
            <p className="mt-1 text-xs font-medium text-destructive">Insufficient balance — top up your wallet to register.</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-bold text-foreground">Full Name</p>
            <Input
              placeholder="E.g. John Doe"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
              className="rounded-2xl border-border bg-muted/40 py-5"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-foreground">Phone Number (10 digits)</p>
              <p className="text-xs text-muted-foreground">MTN Preferred</p>
            </div>
            <Input
              placeholder="E.g. 0241234567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
              disabled={submitting}
              className="rounded-2xl border-border bg-muted/40 py-5 font-mono"
            />
            <div className="flex flex-wrap gap-2">
              {myPhone && (
                <button
                  type="button"
                  onClick={() => setPhoneNumber(myPhone.replace(/\D/g, "").slice(0, 10))}
                  className="flex items-center gap-1.5 rounded-full border border-white/60 dark:border-white/5 bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent clay-sm"
                >
                  <User className="h-3.5 w-3.5" /> My Number ({myPhone})
                </button>
              )}
              <button
                type="button"
                onClick={handlePaste}
                className="flex items-center gap-1.5 rounded-full border border-[#1b388b]/30 bg-[#1b388b]/10 px-3 py-1.5 text-xs font-semibold text-[#1b388b] hover:bg-[#1b388b]/15"
              >
                <ClipboardPaste className="h-3.5 w-3.5" /> Paste
              </button>
              <button
                type="button"
                onClick={() => setPhoneNumber("")}
                className="flex items-center gap-1.5 rounded-full border border-white/60 dark:border-white/5 bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent clay-sm"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-foreground">Ghana Card ID</p>
              <span className="flex items-center gap-1 text-xs font-semibold text-success">
                <ShieldCheck className="h-3.5 w-3.5" /> Auto-Formatted
              </span>
            </div>
            <Input
              placeholder="GHA-123456789-0"
              value={ghCardNumber}
              onChange={(e) => setGhCardNumber(formatGhanaCardInput(e.target.value))}
              disabled={submitting}
              className="rounded-2xl border-border bg-muted/40 py-5 font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <p className="text-sm font-bold text-foreground">Location</p>
              <Input
                placeholder="E.g. Accra, Kumasi, Takoradi"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                disabled={submitting}
                className="rounded-2xl border-border bg-muted/40 py-5"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-bold text-foreground">Region</p>
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                disabled={submitting}
                className="h-[46px] w-full rounded-2xl border border-border bg-muted/40 px-3 text-sm text-foreground"
              >
                <option value="">Select</option>
                {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !isFormValid || !hasSufficientBalance}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#c2660a] py-4 text-base font-bold text-white transition hover:bg-[#a8560a] disabled:opacity-50"
          >
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" /> Submitting...</> : <><Send className="h-4 w-4" /> Submit Registration</>}
          </button>
        </form>
        </>
        )}

        {tab === "stats" && (
          <div className="grid grid-cols-2 gap-3">
            {STATUS_TILES.map(({ key, label, bg, fg }) => (
              <div key={key} className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${bg} ${fg}`}>
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <p className="mt-2 text-xl font-black text-foreground">{stats[key] as number}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
            <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#c2660a]/10 text-[#c2660a]">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <p className="mt-2 text-xl font-black text-[#c2660a]">GHS {stats.totalSpent.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Total GHS Spent</p>
            </div>
          </div>
        )}

        {tab === "history" && (
          <div className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
            {orders.length === 0 ? (
              <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card py-12 text-center text-sm text-muted-foreground clay">
                No AFA registrations yet
              </div>
            ) : (
              orders.map((order) => (
                <div key={order.id} className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-foreground">{order.full_name || order.order_code}</p>
                      <p className="text-xs text-muted-foreground">{order.phone_number || "-"}</p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{order.order_code}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-bold text-foreground">GHS {Number(order.amount).toFixed(2)}</p>
                      <Badge className={`mt-1 ${STATUS_BADGE[order.status] ?? "bg-muted text-muted-foreground"}`}>{order.status}</Badge>
                    </div>
                  </div>
                  <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                    {new Date(order.created_at).toLocaleString()}
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
