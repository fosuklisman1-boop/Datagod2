"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { GraduationCap, Loader2, CheckCircle2, Copy, AlertCircle } from "lucide-react"
import { toast } from "sonner"

interface ResultsCheckerStorefrontFormProps {
  shop: any
  shopSlug: string
}

const EXAM_BOARDS = ["WAEC", "BECE", "NOVDEC"]

interface BoardInfo {
  basePrice: number
  maxMarkup: number
  enabled: boolean
  shopMarkup: number
  customerPrice: number
}

export function ResultsCheckerStorefrontForm({ shop, shopSlug }: ResultsCheckerStorefrontFormProps) {
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [boardInfo, setBoardInfo] = useState<Record<string, BoardInfo>>({})
  const [loadingPrices, setLoadingPrices] = useState(true)

  const [formData, setFormData] = useState({
    customerName: "",
    customerEmail: "",
    customerPhone: "",
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  // Success state
  const [vouchers, setVouchers] = useState<Array<{ pin: string; serial_number: string | null }> | null>(null)
  const [orderRef, setOrderRef] = useState<string | null>(null)
  const [copiedPin, setCopiedPin] = useState<string | null>(null)

  useEffect(() => {
    loadBoardPricing()
  }, [shop])

  const loadBoardPricing = async () => {
    if (!shop?.id) return
    setLoadingPrices(true)
    try {
      // Fetch admin settings for base prices + max markups
      const { createClient } = await import("@supabase/supabase-js")
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )

      const { data: settings } = await supabase
        .from("admin_settings")
        .select("key, value")
        .like("key", "results_checker_%")

      const settingsMap: Record<string, any> = {}
      for (const row of settings ?? []) settingsMap[row.key] = row.value

      const info: Record<string, BoardInfo> = {}
      for (const board of EXAM_BOARDS) {
        const bk = board.toLowerCase()
        const basePrice = settingsMap[`results_checker_price_${bk}`]?.price ?? 0
        const maxMarkup = settingsMap[`results_checker_max_markup_${bk}`]?.max ?? 0
        const enabled = settingsMap[`results_checker_enabled_${bk}`]?.enabled !== false
        const rawMarkup = parseFloat(shop[`results_checker_markup_${bk}`] ?? 0)
        const shopMarkup = Math.min(rawMarkup, maxMarkup)
        info[board] = { basePrice, maxMarkup, enabled, shopMarkup, customerPrice: parseFloat((basePrice + shopMarkup).toFixed(2)) }
      }
      setBoardInfo(info)

      // Auto-select first enabled board
      const first = EXAM_BOARDS.find(b => info[b]?.enabled)
      if (first) setSelectedBoard(first)
    } finally {
      setLoadingPrices(false)
    }
  }

  const validate = () => {
    const errors: Record<string, string> = {}
    if (!formData.customerName.trim()) errors.customerName = "Name is required"
    if (!formData.customerEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.customerEmail)) {
      errors.customerEmail = "Valid email is required"
    }
    if (!formData.customerPhone.trim() || !/^\d{10}$/.test(formData.customerPhone.replace(/\s/g, ""))) {
      errors.customerPhone = "Valid 10-digit phone number required"
    }
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async () => {
    if (!selectedBoard || !validate()) return
    setSubmitting(true)
    try {
      // Step 1: Initialize order
      const initRes = await fetch("/api/shop/results-checker/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: shop.id,
          examBoard: selectedBoard,
          quantity,
          customerName: formData.customerName,
          customerEmail: formData.customerEmail,
          customerPhone: formData.customerPhone.replace(/\s/g, ""),
        }),
      })
      const initData = await initRes.json()
      if (!initRes.ok) {
        toast.error(initData.error ?? "Failed to initialize order")
        return
      }

      // Step 2: Initialize Paystack payment
      const payRes = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: formData.customerEmail,
          amount: initData.totalPrice,
          orderId: initData.orderId,
          orderType: "results_checker",
          shopId: shop.id,
          shopSlug,
        }),
      })
      const payData = await payRes.json()
      if (!payRes.ok) {
        toast.error(payData.error ?? "Payment initialization failed")
        return
      }

      // Step 3: Redirect to Paystack
      window.location.href = payData.authorizationUrl

    } catch {
      toast.error("Something went wrong. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopyPin = (pin: string) => {
    navigator.clipboard.writeText(pin)
    setCopiedPin(pin)
    setTimeout(() => setCopiedPin(null), 2000)
  }

  const totalPrice = selectedBoard && boardInfo[selectedBoard]
    ? parseFloat((boardInfo[selectedBoard].customerPrice * quantity).toFixed(2))
    : 0

  if (loadingPrices) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-violet-600" />
      </div>
    )
  }

  // Success view (after Paystack redirect back — not used for redirected flow, but kept for potential inline use)
  if (vouchers && orderRef) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <div className="text-center">
          <div className="text-4xl mb-2">🎓</div>
          <h2 className="text-xl font-bold text-green-700">Vouchers Delivered!</h2>
          <p className="text-sm text-gray-500">Ref: {orderRef}</p>
        </div>
        <div className="space-y-2">
          {vouchers.map((v, i) => (
            <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 border">
              <div>
                <p className="text-xs text-gray-400">Voucher {i + 1}</p>
                <p className="font-mono font-bold tracking-wider text-gray-900">{v.pin}</p>
                {v.serial_number && <p className="text-xs text-gray-400 font-mono">Serial: {v.serial_number}</p>}
              </div>
              <button onClick={() => handleCopyPin(v.pin)} className="p-2 hover:bg-gray-200 rounded-lg">
                {copiedPin === v.pin
                  ? <CheckCircle2 className="w-4 h-4 text-green-600" />
                  : <Copy className="w-4 h-4 text-gray-500" />}
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-center text-gray-400">Vouchers also sent to your email and phone.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-2xl font-black mb-2 text-gray-900 border-l-4 border-violet-600 pl-4">Results Checker Vouchers</h2>
        <p className="text-gray-500 text-sm pl-5">WAEC · BECE · NOVDEC — instant PIN delivery</p>
      </div>

      {/* Board selection */}
      <div className="grid grid-cols-3 gap-4">
        {EXAM_BOARDS.map(board => {
          const info = boardInfo[board]
          if (!info) return null
          return (
            <Card
              key={board}
              onClick={() => info.enabled && setSelectedBoard(board)}
              className={`group cursor-pointer transition-all duration-300 overflow-hidden border-0 ${
                !info.enabled
                  ? "opacity-40 cursor-not-allowed shadow-sm"
                  : selectedBoard === board
                  ? "ring-4 ring-violet-600 shadow-xl"
                  : "shadow-md hover:shadow-xl hover:-translate-y-1"
              }`}
            >
              <div className={`h-2 ${selectedBoard === board ? "bg-violet-600" : "bg-gray-200 group-hover:bg-violet-300"} transition-colors`} />
              <CardContent className="pt-4 pb-4 text-center">
                <GraduationCap className={`w-8 h-8 mx-auto mb-2 ${selectedBoard === board ? "text-violet-600" : "text-gray-400"}`} />
                <p className={`font-black text-lg ${selectedBoard === board ? "text-violet-700" : "text-gray-800"}`}>{board}</p>
                <p className="text-2xl font-black text-gray-900 mt-1">GHS {info.customerPrice.toFixed(2)}</p>
                <p className="text-xs text-gray-400 mt-1">per voucher</p>
                {!info.enabled && <p className="text-xs text-red-500 mt-1 font-medium">Unavailable</p>}
                {selectedBoard === board && (
                  <div className="absolute top-3 right-3">
                    <CheckCircle2 className="w-5 h-5 text-violet-600" />
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {selectedBoard && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Quantity */}
          <div>
            <Label className="text-sm font-semibold text-gray-700">Quantity</Label>
            <div className="flex items-center gap-3 mt-2">
              <button onClick={() => setQuantity(q => Math.max(1, q - 1))}
                className="w-10 h-10 rounded-xl border-2 flex items-center justify-center font-bold text-gray-700 hover:bg-gray-50 transition-colors">−</button>
              <Input type="number" min="1" max="50" value={quantity}
                onChange={e => setQuantity(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                className="w-20 text-center font-bold text-lg h-10 rounded-xl" />
              <button onClick={() => setQuantity(q => Math.min(50, q + 1))}
                className="w-10 h-10 rounded-xl border-2 flex items-center justify-center font-bold text-gray-700 hover:bg-gray-50 transition-colors">+</button>
              <span className="text-sm text-gray-500 ml-2">max 50</span>
            </div>
          </div>

          {/* Customer details */}
          <div className="space-y-4">
            <h3 className="font-semibold text-gray-800">Your Details</h3>
            <div>
              <Label className="text-sm">Full Name</Label>
              <Input value={formData.customerName} onChange={e => setFormData(p => ({ ...p, customerName: e.target.value }))}
                placeholder="e.g. Kwame Mensah" className={`mt-1 ${formErrors.customerName ? "border-red-400" : ""}`} />
              {formErrors.customerName && <p className="text-xs text-red-500 mt-1">{formErrors.customerName}</p>}
            </div>
            <div>
              <Label className="text-sm">Email Address</Label>
              <Input type="email" value={formData.customerEmail} onChange={e => setFormData(p => ({ ...p, customerEmail: e.target.value }))}
                placeholder="e.g. kwame@example.com" className={`mt-1 ${formErrors.customerEmail ? "border-red-400" : ""}`} />
              {formErrors.customerEmail && <p className="text-xs text-red-500 mt-1">{formErrors.customerEmail}</p>}
            </div>
            <div>
              <Label className="text-sm">Phone Number</Label>
              <Input value={formData.customerPhone} onChange={e => setFormData(p => ({ ...p, customerPhone: e.target.value }))}
                placeholder="0XX XXX XXXX" className={`mt-1 ${formErrors.customerPhone ? "border-red-400" : ""}`} />
              {formErrors.customerPhone && <p className="text-xs text-red-500 mt-1">{formErrors.customerPhone}</p>}
              <p className="text-xs text-gray-400 mt-1">Voucher PINs will be sent to this number via SMS</p>
            </div>
          </div>

          {/* Price summary */}
          <div className="bg-violet-50 rounded-xl p-4 space-y-2 text-sm border border-violet-100">
            <div className="flex justify-between text-gray-600">
              <span>{selectedBoard} voucher × {quantity}</span>
              <span>GHS {(boardInfo[selectedBoard]?.customerPrice ?? 0).toFixed(2)} × {quantity}</span>
            </div>
            <div className="flex justify-between font-bold text-gray-900 text-lg border-t border-violet-200 pt-2">
              <span>Total</span>
              <span>GHS {totalPrice.toFixed(2)}</span>
            </div>
          </div>

          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full h-14 bg-slate-900 hover:bg-violet-700 text-white font-black rounded-xl shadow-xl transition-all duration-300 text-base"
          >
            {submitting
              ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Processing…</>
              : `Pay GHS ${totalPrice.toFixed(2)} with Paystack`
            }
          </Button>

          <p className="text-xs text-center text-gray-400 flex items-center justify-center gap-1">
            <AlertCircle className="w-3 h-3" />
            PINs delivered instantly by SMS &amp; email after payment
          </p>
        </div>
      )}
    </div>
  )
}
