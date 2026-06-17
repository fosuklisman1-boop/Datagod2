"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { GraduationCap, Loader2, CheckCircle2, Copy, AlertCircle, Download } from "lucide-react"
import { toast } from "sonner"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { useResendCooldown } from "@/lib/use-resend-cooldown"

interface ResultsCheckerStorefrontFormProps {
  shop: any
  shopSlug: string
}

const EXAM_BOARDS = ["WASSCE", "BECE", "NOVDEC"]

interface BoardInfo {
  basePrice: number
  maxMarkup: number
  enabled: boolean
  shopMarkup: number
  customerPrice: number
  availableCount: number
  bulkMinQty?: number
  bulkPrice?: number  // effective customer price per voucher at bulk rate (base + markup)
}

export function ResultsCheckerStorefrontForm({ shop, shopSlug }: ResultsCheckerStorefrontFormProps) {
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [boardInfo, setBoardInfo] = useState<Record<string, BoardInfo>>({})
  const [loadingPrices, setLoadingPrices] = useState(true)
  const [maxQuantity, setMaxQuantity] = useState(50)

  const [formData, setFormData] = useState({
    customerName: "",
    customerEmail: "",
    customerPhone: "",
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string>("")
  const [turnstileEnabled, setTurnstileEnabled] = useState<boolean>(true)
  const [honeypot, setHoneypot] = useState<string>("")
  // Checkout phone-OTP gate (verifies the PAYMENT number that gets charged).
  // Direct charge is an INDEPENDENT toggle: pay on-page via momoDirect vs the
  // hosted Paystack redirect, regardless of whether OTP is required.
  const [otpRequired, setOtpRequired] = useState<boolean>(false)
  const [directCharge, setDirectCharge] = useState<boolean>(false)
  const [paymentPhone, setPaymentPhone] = useState("")
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [otpVerified, setOtpVerified] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const otpCooldown = useResendCooldown(paymentPhone.replace(/\D/g, ""))
  // Live "approve the prompt" modal for the direct-charge flow
  const [momoModal, setMomoModal] = useState<null | { state: "awaiting" | "success" | "failed"; orderId?: string; reference?: string; summary?: any; message?: string }>(null)

  // Success state
  const [vouchers, setVouchers] = useState<Array<{ pin: string; serial_number: string | null }> | null>(null)
  const [orderRef, setOrderRef] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  useEffect(() => {
    loadBoardPricing()
  }, [shop])

  useEffect(() => {
    // Fetch checkout requirements (Turnstile + OTP gate)
    fetch("/api/public/turnstile-status")
      .then(r => r.ok ? r.json() : { enabled: true, otp_required: false, direct_charge: false })
      .then(d => { setTurnstileEnabled(d.enabled !== false); setOtpRequired(d.otp_required === true); setDirectCharge(d.direct_charge === true) })
      .catch(() => { setTurnstileEnabled(true); setOtpRequired(false); setDirectCharge(false) })
  }, [])

  // One-time OTP: auto-skip the step if the PAYMENT number was already verified.
  useEffect(() => {
    if (!otpRequired || otpVerified) return
    const phone = paymentPhone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(phone)) return
    const t = setTimeout(() => {
      fetch("/api/public/phone-verified", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone.replace(/\s/g, "") }),
      }).then(r => r.ok ? r.json() : { verified: false }).then(d => { if (d.verified) setOtpVerified(true) }).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [paymentPhone, otpRequired, otpVerified])

  const handleSendOtp = async () => {
    const phone = paymentPhone.replace(/\s/g, "")
    if (!/^\d{10}$/.test(phone)) { toast.error("Enter a valid 10-digit Mobile Money number first"); return }
    setSendingOtp(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
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
        body: JSON.stringify({ phone: paymentPhone.replace(/\s/g, ""), code: otpCode.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.verified) { toast.error(d?.error || "Incorrect code"); return }
      toast.success("Payment number verified ✓"); setOtpVerified(true)
    } catch { toast.error("Network error") } finally { setVerifyingOtp(false) }
  }

  // Poll results-checker order status while the live MoMo prompt modal is open.
  const pollMomoStatus = (orderId: string, reference: string, summary: any) => {
    const started = Date.now()
    const TIMEOUT_MS = 4 * 60 * 1000
    const tick = async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        setMomoModal({ state: "failed", message: "Payment timed out. If you approved the prompt, your order will still be processed — check your SMS/email, or try again." })
        return
      }
      try {
        const res = await fetch(`/api/payments/momo-status?orderId=${orderId}&orderType=results_checker`)
        const d = await res.json().catch(() => ({ status: "pending" }))
        if (d.status === "completed") { setMomoModal({ state: "success", orderId, reference, summary }); return }
        if (d.status === "failed") { setMomoModal({ state: "failed", message: "Payment was not completed. Please try again." }); return }
      } catch { /* keep polling */ }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 3000)
  }

  const loadBoardPricing = async () => {
    // NB: shop comes from getShopBySlug, which does not select the `id` column,
    // so guard on `shop` itself — keying on shop?.id left the spinner stuck.
    if (!shop) { setLoadingPrices(false); return }
    setLoadingPrices(true)
    try {
      // Fetch admin settings for base prices + max markups
      // admin_settings is locked to service_role; read curated config via the
      // public config endpoint instead of the (now-denied) anon client.
      const settingsMap: Record<string, any> = {}
      try {
        const cfgRes = await fetch("/api/public/config")
        if (cfgRes.ok) {
          const cfg = await cfgRes.json()
          Object.assign(settingsMap, cfg.admin_settings ?? {})
        }
      } catch (e) {
        console.warn("Could not load results-checker config:", e)
      }

      // Count available inventory per board via server-side API (anon key cannot read inventory table)
      const availableCounts: Record<string, number> = { WASSCE: 0, BECE: 0, NOVDEC: 0 }
      try {
        const avRes = await fetch("/api/shop/results-checker/availability")
        if (avRes.ok) {
          const avData = await avRes.json()
          Object.assign(availableCounts, avData.counts ?? {})
        }
      } catch (e) {
        console.warn("Could not load availability counts:", e)
      }

      const maxQty: number = settingsMap["results_checker_max_quantity"]?.max ?? 50
      setMaxQuantity(maxQty)

      const bulkMinQty: number = settingsMap["results_checker_bulk_min_quantity"]?.min ?? 0

      const info: Record<string, BoardInfo> = {}
      for (const board of EXAM_BOARDS) {
        const bk = board.toLowerCase()
        const basePrice = settingsMap[`results_checker_price_${bk}`]?.price ?? 0
        const maxMarkup = settingsMap[`results_checker_max_markup_${bk}`]?.max ?? 0
        const enabled = settingsMap[`results_checker_enabled_${bk}`]?.enabled !== false
        const rawMarkup = parseFloat(shop[`results_checker_markup_${bk}`] ?? 0)
        const shopMarkup = Math.min(rawMarkup, maxMarkup)
        const customerPrice = parseFloat((basePrice + shopMarkup).toFixed(2))

        // Bulk pricing: bulk base must be lower than the regular base price
        const bulkBasePrice: number = settingsMap[`results_checker_bulk_price_${bk}`]?.price ?? 0
        const bulkPrice =
          bulkMinQty > 0 && bulkBasePrice > 0 && bulkBasePrice < basePrice
            ? parseFloat((bulkBasePrice + shopMarkup).toFixed(2))
            : undefined

        info[board] = {
          basePrice, maxMarkup, enabled, shopMarkup, customerPrice,
          availableCount: availableCounts[board],
          bulkMinQty: bulkMinQty > 0 ? bulkMinQty : undefined,
          bulkPrice,
        }
      }
      setBoardInfo(info)

      // Auto-select first enabled board with stock
      const first = EXAM_BOARDS.find(b => info[b]?.enabled && info[b]?.availableCount > 0)
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
    if (otpRequired && !otpVerified) {
      toast.error("Please verify your Mobile Money number first")
      return
    }
    if (directCharge && !otpRequired && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, ""))) {
      toast.error("Enter a valid Mobile Money number to pay from")
      return
    }
    setSubmitting(true)
    try {
      // Step 1: Initialize order
      const initRes = await fetch("/api/shop/results-checker/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSlug,
          examBoard: selectedBoard,
          quantity,
          customerName: formData.customerName,
          customerEmail: formData.customerEmail,
          customerPhone: formData.customerPhone.replace(/\s/g, ""),
          // The MoMo number we charge on-page (direct charge) and/or OTP-verify.
          paymentPhone: (otpRequired || directCharge) ? paymentPhone.replace(/\s/g, "") : undefined,
          turnstileToken,
          website: honeypot,
        }),
      })
      const initData = await initRes.json()
      if (!initRes.ok) {
        toast.error(initData.error ?? "Failed to initialize order")
        return
      }

      // ── Direct MoMo charge path (direct-charge toggle ON) ────────────────
      // Charge the on-page payment number directly, then keep the buyer on-page
      // with a live modal that polls until the webhook confirms the prompt.
      if (directCharge) {
        const summary = {
          packageLabel: `${selectedBoard} voucher × ${quantity}`,
          paymentPhone: paymentPhone.replace(/\s/g, ""),
          amount: initData.totalPrice,
        }
        const chargeRes = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: formData.customerEmail,
            amount: initData.totalPrice,
            orderId: initData.orderId,
            orderType: "results_checker",
            shopSlug,
            momoDirect: true,
            paymentPhone: paymentPhone.replace(/\s/g, ""),
          }),
        })
        const chargeData = await chargeRes.json().catch(() => ({}))
        if (!chargeRes.ok || !chargeData.success) {
          toast.error(chargeData?.error ?? "Could not start the Mobile Money charge. Please try again.")
          return
        }
        setMomoModal({ state: "awaiting", orderId: initData.orderId, reference: chargeData.reference, summary })
        pollMomoStatus(initData.orderId, chargeData.reference, { ...summary, reference: chargeData.reference })
        return
      }

      // Step 2: Initialize Paystack payment (hosted redirect — gate OFF)
      const payRes = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: formData.customerEmail,
          amount: initData.totalPrice,
          orderId: initData.orderId,
          orderType: "results_checker",
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

  const handleCopyVoucher = (v: { pin: string; serial_number: string | null }, idx: number) => {
    const text = `Serial: ${v.serial_number ?? "N/A"}\nPIN: ${v.pin}`
    navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    toast.success("Serial & PIN copied")
    setTimeout(() => setCopiedIdx(null), 2000)
  }

  const triggerExcelDownload = async (voucherList: Array<{ pin: string; serial_number: string | null }>, board: string, ref: string) => {
    try {
      const { utils, write } = await import("xlsx")
      const rows = [
        ["DATAGOD — Results Checker Voucher Receipt"],
        [],
        ["Reference", ref],
        ["Exam Board", board],
        ["Quantity", voucherList.length],
        ["Date", new Date().toLocaleString()],
        [],
        ["#", "Serial Number", "PIN"],
        ...voucherList.map((v, i) => [i + 1, v.serial_number ?? "N/A", v.pin]),
        [],
        ["Keep these details safe. Use them on the official exam results portal."],
      ]
      const ws = utils.aoa_to_sheet(rows)
      ws["!cols"] = [{ wch: 14 }, { wch: 20 }, { wch: 18 }]
      const wb = utils.book_new()
      utils.book_append_sheet(wb, ws, "Vouchers")
      const buf = write(wb, { type: "array", bookType: "xlsx" })
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${board}-vouchers-${ref}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.warn("Download failed:", e)
    }
  }

  const activeBoardInfo = selectedBoard ? boardInfo[selectedBoard] : null
  const bulkActive = !!(
    activeBoardInfo?.bulkMinQty &&
    activeBoardInfo?.bulkPrice &&
    quantity >= activeBoardInfo.bulkMinQty
  )
  const effectivePricePerVoucher = activeBoardInfo
    ? (bulkActive ? activeBoardInfo.bulkPrice! : activeBoardInfo.customerPrice)
    : 0
  const totalPrice = parseFloat((effectivePricePerVoucher * quantity).toFixed(2))

  if (loadingPrices) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    )
  }

  // Success view (after Paystack redirect back — not used for redirected flow, but kept for potential inline use)
  if (vouchers && orderRef) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <div className="text-center">
          <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-2" />
          <h2 className="text-xl font-bold text-success">Vouchers Delivered!</h2>
          <p className="text-sm text-muted-foreground">Ref: {orderRef}</p>
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => triggerExcelDownload(vouchers, selectedBoard ?? "", orderRef)}
            className="flex items-center gap-1.5 text-xs text-primary hover:text-primary font-medium border border-border hover:border-border rounded-full px-2.5 py-1 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download receipt
          </button>
        </div>
        <div className="space-y-2">
          {vouchers.map((v, i) => (
            <div key={i} className="flex items-center justify-between bg-muted/40 rounded-lg px-4 py-3 border">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground mb-1">Voucher {i + 1}</p>
                <p className="text-xs text-muted-foreground">Serial Number</p>
                <p className="font-mono font-semibold text-foreground text-sm">{v.serial_number ?? "N/A"}</p>
                <p className="text-xs text-muted-foreground mt-1">PIN</p>
                <p className="font-mono font-bold tracking-widest text-foreground text-lg">{v.pin}</p>
              </div>
              <button onClick={() => handleCopyVoucher(v, i)} className="p-2 border border-border hover:bg-muted rounded-lg flex-shrink-0 ml-3">
                {copiedIdx === i
                  ? <CheckCircle2 className="w-4 h-4 text-success" />
                  : <Copy className="w-4 h-4 text-muted-foreground" />}
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-center text-muted-foreground">Vouchers also sent to your email and phone.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-2xl font-black mb-2 text-foreground border-l-4 border-primary pl-4">Results Checker Vouchers</h2>
        <p className="text-muted-foreground text-sm pl-5">WASSCE · BECE · NOVDEC — instant serial &amp; PIN delivery</p>
      </div>

      {/* Board selection */}
      <div className="grid grid-cols-3 gap-4">
        {EXAM_BOARDS.map(board => {
          const info = boardInfo[board]
          if (!info) return null
          return (
            <Card
              key={board}
              onClick={() => info.enabled && info.availableCount > 0 && setSelectedBoard(board)}
              className={`group cursor-pointer transition-all duration-300 overflow-hidden border-0 ${
                !info.enabled || info.availableCount === 0
                  ? "opacity-40 cursor-not-allowed shadow-sm"
                  : selectedBoard === board
                  ? "ring-4 ring-primary shadow-xl"
                  : "shadow-md hover:shadow-xl hover:-translate-y-1"
              }`}
            >
              <div className={`h-2 ${selectedBoard === board ? "bg-primary" : "bg-muted group-hover:bg-primary"} transition-colors`} />
              <CardContent className="pt-4 pb-4 text-center">
                <GraduationCap className={`w-8 h-8 mx-auto mb-2 ${selectedBoard === board ? "text-primary" : "text-muted-foreground"}`} />
                <p className={`font-black text-lg ${selectedBoard === board ? "text-primary" : "text-foreground"}`}>{board}</p>
                <p className="text-2xl font-black text-foreground mt-1">GHS {info.customerPrice.toFixed(2)}</p>
                <p className="text-xs text-muted-foreground mt-1">per voucher</p>
                {info.bulkMinQty && info.bulkPrice && (
                  <p className="text-xs text-primary font-bold mt-1">
                    {info.bulkMinQty}+ @ GHS {info.bulkPrice.toFixed(2)}/ea
                  </p>
                )}
                {!info.enabled
                  ? <p className="text-xs text-destructive mt-1 font-medium">Unavailable</p>
                  : info.availableCount === 0
                  ? <p className="text-xs text-destructive mt-1 font-medium">Out of stock</p>
                  : null}
                {selectedBoard === board && (
                  <div className="absolute top-3 right-3">
                    <CheckCircle2 className="w-5 h-5 text-primary" />
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
            <Label className="text-sm font-semibold text-foreground">Quantity</Label>
            <div className="flex items-center gap-3 mt-2">
              <button onClick={() => setQuantity(q => Math.max(1, q - 1))}
                className="w-10 h-10 rounded-xl border-2 flex items-center justify-center font-bold text-foreground hover:bg-accent transition-colors">−</button>
              <Input type="number" min="1" max={maxQuantity} value={quantity}
                onChange={e => setQuantity(Math.max(1, Math.min(maxQuantity, parseInt(e.target.value) || 1)))}
                className="w-20 text-center font-bold text-lg h-10 rounded-xl" />
              <button onClick={() => setQuantity(q => Math.min(maxQuantity, q + 1))}
                className="w-10 h-10 rounded-xl border-2 flex items-center justify-center font-bold text-foreground hover:bg-accent transition-colors">+</button>
              <span className="text-sm text-muted-foreground ml-2">max {maxQuantity}</span>
            </div>
          </div>

          {/* Customer details */}
          <div className="space-y-4">
            <h3 className="font-semibold text-foreground">Your Details</h3>
            <div>
              <Label className="text-sm">Full Name</Label>
              <Input value={formData.customerName} onChange={e => setFormData(p => ({ ...p, customerName: e.target.value }))}
                placeholder="e.g. Kwame Mensah" className={`mt-1 ${formErrors.customerName ? "border-destructive" : ""}`} />
              {formErrors.customerName && <p className="text-xs text-destructive mt-1">{formErrors.customerName}</p>}
            </div>
            <div>
              <Label className="text-sm">Email Address</Label>
              <Input type="email" value={formData.customerEmail} onChange={e => setFormData(p => ({ ...p, customerEmail: e.target.value }))}
                placeholder="e.g. kwame@example.com" className={`mt-1 ${formErrors.customerEmail ? "border-destructive" : ""}`} />
              {formErrors.customerEmail && <p className="text-xs text-destructive mt-1">{formErrors.customerEmail}</p>}
            </div>
            <div>
              <Label className="text-sm">Phone Number</Label>
              <Input value={formData.customerPhone} onChange={e => {
                  setFormData(p => ({ ...p, customerPhone: e.target.value }))
                  if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode("") }
                }}
                placeholder="0XX XXX XXXX" className={`mt-1 ${formErrors.customerPhone ? "border-destructive" : ""}`} />
              {formErrors.customerPhone && <p className="text-xs text-destructive mt-1">{formErrors.customerPhone}</p>}
              <p className="text-xs text-muted-foreground mt-1">Voucher serial numbers &amp; PINs will be sent to this number via SMS</p>
            </div>
          </div>

          {/* Price summary */}
          <div className="bg-primary rounded-xl p-4 space-y-2 text-sm border border-border">
            <div className="flex justify-between text-muted-foreground">
              <span>{selectedBoard} voucher × {quantity}</span>
              <span>GHS {effectivePricePerVoucher.toFixed(2)} × {quantity}</span>
            </div>
            {bulkActive && (
              <div className="flex items-center gap-1.5 text-primary font-semibold text-xs bg-primary rounded-lg px-3 py-1.5">
                <span>✓ Bulk rate applied — GHS {activeBoardInfo!.bulkPrice!.toFixed(2)}/ea (save GHS {((activeBoardInfo!.customerPrice - activeBoardInfo!.bulkPrice!) * quantity).toFixed(2)})</span>
              </div>
            )}
            {!bulkActive && activeBoardInfo?.bulkMinQty && activeBoardInfo?.bulkPrice && (
              <div className="text-xs text-primary font-medium">
                Buy {activeBoardInfo.bulkMinQty - quantity} more to unlock bulk rate (GHS {activeBoardInfo.bulkPrice.toFixed(2)}/ea)
              </div>
            )}
            <div className="flex justify-between font-bold text-foreground text-lg border-t border-border pt-2">
              <span>Total</span>
              <span>GHS {totalPrice.toFixed(2)}</span>
            </div>
          </div>

          <HoneypotField value={honeypot} onChange={setHoneypot} />

          {/* Payment-number step. Shown when OTP verification OR direct charge is
              on — both need the on-page MoMo number. OTP controls render only when
              OTP is required; with direct charge alone the number is charged as typed. */}
          {(otpRequired || directCharge) && (
            <div className="p-4 rounded-xl bg-primary border border-border space-y-3">
              <div>
                <Label className="text-sm font-semibold text-primary">Mobile Money number to pay from</Label>
                <Input
                  inputMode="numeric"
                  placeholder="0241234567"
                  value={paymentPhone}
                  onChange={e => {
                    setPaymentPhone(e.target.value)
                    if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode(""); otpCooldown.reset() }
                  }}
                  disabled={otpRequired && otpVerified}
                  className="mt-1 bg-card font-mono"
                />
                <p className="text-xs text-primary mt-1">
                  {otpRequired ? "The payment prompt is sent to this number. You verify it once." : "The payment prompt is sent to this number."}
                </p>
              </div>

              {otpRequired && (!otpVerified ? (
                !otpSent ? (
                  <Button type="button" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full bg-primary hover:bg-primary text-white rounded-xl">
                    {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <Input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otpCode}
                      onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      className="text-center text-lg tracking-[0.4em] font-mono bg-card" />
                    <div className="flex gap-2">
                      <Button type="button" onClick={handleVerifyOtp} disabled={verifyingOtp || otpCode.length < 4} className="flex-1 bg-primary hover:bg-primary text-white rounded-xl">
                        {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                      </Button>
                      <Button type="button" variant="outline" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>{otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                  </div>
                )
              ) : (
                <div className="p-3 rounded-xl bg-success/10 border border-border flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-success" />
                  <span className="text-sm font-medium text-success">Payment number verified ✓</span>
                </div>
              ))}
            </div>
          )}

          {turnstileEnabled && (
            <div className="flex justify-center">
              <TurnstileWidget onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
            </div>
          )}

          <Button
            onClick={handleSubmit}
            disabled={submitting || (turnstileEnabled && !turnstileToken) || (otpRequired && !otpVerified) || (directCharge && !otpRequired && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, "")))}
            className="w-full h-14 bg-slate-900 hover:bg-primary text-white font-black rounded-xl shadow-xl transition-all duration-300 text-base"
          >
            {submitting
              ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Processing…</>
              : directCharge
                ? `Pay GHS ${totalPrice.toFixed(2)}`
                : `Pay GHS ${totalPrice.toFixed(2)} with Paystack`
            }
          </Button>

          <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Serial numbers &amp; PINs delivered instantly by SMS &amp; email after payment
          </p>
        </div>
      )}

      {/* Live Mobile Money prompt modal (direct-charge flow). */}
      {momoModal && (
        <div className="fixed inset-0 bg-background/60 flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-md bg-card rounded-2xl">
            {momoModal.state === "awaiting" && (
              <CardContent className="pt-8 pb-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-primary flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
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
                <div className="mx-auto w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
                  <CheckCircle2 className="w-9 h-9 text-success" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Payment successful 🎉</h3>
                  <p className="text-sm text-muted-foreground mt-1">Your vouchers are ready. View them now, or check your SMS &amp; email.</p>
                </div>
                <div className="text-left p-4 rounded-lg bg-muted/40 border border-border space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Item</span><span className="font-medium">{momoModal.summary?.packageLabel}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Paid from</span><span className="font-medium">{momoModal.summary?.paymentPhone}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold">GHS {Number(momoModal.summary?.amount || 0).toFixed(2)}</span></div>
                  {momoModal.reference && (
                    <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span className="font-mono text-xs">{momoModal.reference}</span></div>
                  )}
                </div>
                <Button
                  onClick={() => {
                    // Reuse the existing secure confirmation page to display vouchers.
                    window.location.href = `/shop/${shopSlug}/results-checker/confirmation?reference=${momoModal.reference}&orderId=${momoModal.orderId}`
                  }}
                  className="w-full bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary rounded-xl"
                >
                  View my vouchers
                </Button>
              </CardContent>
            )}

            {momoModal.state === "failed" && (
              <CardContent className="pt-8 pb-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-destructive/15 flex items-center justify-center">
                  <AlertCircle className="w-9 h-9 text-destructive" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Payment not completed</h3>
                  <p className="text-sm text-muted-foreground mt-1">{momoModal.message || "The prompt was not approved. Please try again."}</p>
                </div>
                <Button variant="outline" onClick={() => setMomoModal(null)} className="w-full rounded-xl">Close</Button>
              </CardContent>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
