"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ClipboardCheck, GraduationCap, Loader2, CheckCircle2, AlertCircle } from "lucide-react"
import { toast } from "sonner"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { useResendCooldown } from "@/lib/use-resend-cooldown"
import {
  EXAM_BOARDS,
  type ExamBoard,
  isValidIndexNumber,
  isValidVoucherPin,
  isValidVoucherSerial,
  isValidDob,
  isValidExamYear,
  isValidGhanaPhone,
} from "@/lib/results-check-validation"

interface ResultsCheckServiceFormProps {
  shop: any
  shopSlug: string
}

interface BoardInfo {
  enabled: boolean
  checkFee: number       // own_voucher price (check fee + shop markup, same across boards)
  comboPrice: number     // combo price (checkFee + voucher price), only meaningful if availableCount > 0
  availableCount: number
}

type CandidateType = "school" | "private"
type CheckMode = "combo" | "own_voucher"

export function ResultsCheckServiceForm({ shop, shopSlug }: ResultsCheckServiceFormProps) {
  const [serviceEnabled, setServiceEnabled] = useState(true)
  const [loadingPrices, setLoadingPrices] = useState(true)
  const [boardInfo, setBoardInfo] = useState<Record<string, BoardInfo>>({})

  const [selectedBoard, setSelectedBoard] = useState<ExamBoard | null>(null)
  const [candidateType, setCandidateType] = useState<CandidateType | null>(null)
  const [mode, setMode] = useState<CheckMode | null>(null)

  const [formData, setFormData] = useState({
    voucherPin: "",
    voucherSerial: "",
    indexNumber: "",
    examYear: "",
    dob: "",
    customerName: "",
    customerEmail: "",
    phoneNumber: "",
    whatsappNumber: "",
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

  // Progressive-disclosure scroll targets. Each selection reveals the next
  // section; we scroll it into view so the user isn't left below the fold.
  const candidateRef = useRef<HTMLDivElement>(null)
  const modeRef = useRef<HTMLDivElement>(null)
  const detailsRef = useRef<HTMLDivElement>(null)
  // Wait one frame for the newly-revealed section to mount before scrolling.
  const scrollToRef = (ref: React.RefObject<HTMLDivElement | null>) => {
    setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 120)
  }

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

  // Poll the results-check request status while the live MoMo prompt modal is open.
  const pollMomoStatus = (orderId: string, reference: string, summary: any) => {
    const started = Date.now()
    const TIMEOUT_MS = 4 * 60 * 1000
    const tick = async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        setMomoModal({ state: "failed", message: "Payment timed out. If you approved the prompt, your request will still be processed — check your SMS, or try again." })
        return
      }
      try {
        const res = await fetch(`/api/payments/momo-status?orderId=${orderId}&orderType=results_check_service`)
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
      // admin_settings is locked to service_role; read curated config via the
      // public config endpoint instead of the (denied) anon client.
      const settingsMap: Record<string, any> = {}
      try {
        const cfgRes = await fetch("/api/public/config")
        if (cfgRes.ok) {
          const cfg = await cfgRes.json()
          Object.assign(settingsMap, cfg.admin_settings ?? {})
        }
      } catch (e) {
        console.warn("Could not load results-check config:", e)
      }

      const rcSettings = settingsMap["results_check_settings"]
      if (rcSettings?.enabled === false) {
        setServiceEnabled(false)
        return
      }

      const baseCheckFee = parseFloat(rcSettings?.fee ?? 0)
      const maxCheckMarkup = parseFloat(settingsMap["results_check_max_markup"]?.max ?? 0)
      const rawShopCheckMarkup = parseFloat(shop?.results_check_markup ?? 0)
      const checkFeeMarkup = Math.min(rawShopCheckMarkup, maxCheckMarkup)
      const effectiveCheckFee = parseFloat((baseCheckFee + checkFeeMarkup).toFixed(2))

      // Count available combo inventory per board via server-side API (anon key cannot read inventory table)
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

      const info: Record<string, BoardInfo> = {}
      for (const board of EXAM_BOARDS) {
        const bk = board.toLowerCase()
        const enabled = settingsMap[`results_checker_enabled_${bk}`]?.enabled !== false

        const voucherBase = settingsMap[`results_checker_price_${bk}`]?.price ?? 0
        const voucherMaxMarkup = settingsMap[`results_checker_max_markup_${bk}`]?.max ?? 0
        const rawVoucherMarkup = parseFloat(shop?.[`results_checker_markup_${bk}`] ?? 0)
        const voucherShopMarkup = Math.min(rawVoucherMarkup, voucherMaxMarkup)
        const voucherPrice = parseFloat((voucherBase + voucherShopMarkup).toFixed(2))

        info[board] = {
          enabled,
          checkFee: effectiveCheckFee,
          comboPrice: parseFloat((effectiveCheckFee + voucherPrice).toFixed(2)),
          availableCount: availableCounts[board] ?? 0,
        }
      }
      setBoardInfo(info)

      // Auto-select first enabled board
      const first = EXAM_BOARDS.find(b => info[b]?.enabled)
      if (first) setSelectedBoard(first)
    } finally {
      setLoadingPrices(false)
    }
  }

  const selectBoard = (board: ExamBoard) => {
    if (!boardInfo[board]?.enabled) return
    setSelectedBoard(board)
    setCandidateType(null)
    setMode(null)
    scrollToRef(candidateRef)
  }

  // Single source of truth for per-field error messages. Returns null when the
  // field is valid. Used by both submit-time validate() and on-blur validation.
  const fieldError = (field: string): string | null => {
    switch (field) {
      case "voucherPin":
        return mode === "own_voucher" && !isValidVoucherPin(formData.voucherPin.trim())
          ? "Enter a valid 12-digit voucher PIN" : null
      case "voucherSerial":
        return mode === "own_voucher" && !isValidVoucherSerial(formData.voucherSerial.trim())
          ? "Enter a valid voucher serial number" : null
      case "indexNumber":
        if (!selectedBoard) return null
        return (!formData.indexNumber.trim() || !isValidIndexNumber(selectedBoard, formData.indexNumber.trim()))
          ? (selectedBoard === "BECE" ? "Enter a valid 10 or 12-digit index number" : "Enter a valid 10-digit index number")
          : null
      case "examYear":
        return !isValidExamYear(parseInt(formData.examYear))
          ? `Enter a valid exam year (1980–${new Date().getFullYear()})` : null
      case "dob":
        return !isValidDob(formData.dob)
          ? "Enter a valid date of birth as DD/MM/YYYY" : null
      case "customerName":
        return !formData.customerName.trim() ? "Name is required" : null
      case "customerEmail":
        return (!formData.customerEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.customerEmail))
          ? "Valid email is required" : null
      case "phoneNumber":
        return !isValidGhanaPhone(formData.phoneNumber.replace(/\s/g, ""))
          ? "Valid 10-digit Mobile Money number required" : null
      case "whatsappNumber":
        return !isValidGhanaPhone(formData.whatsappNumber.replace(/\s/g, ""))
          ? "Valid 10-digit WhatsApp number required" : null
      default:
        return null
    }
  }

  // Validate a single field on blur, so the user is told early — before moving on.
  const validateField = (field: string) => {
    const err = fieldError(field)
    setFormErrors(prev => {
      const next = { ...prev }
      if (err) next[field] = err
      else delete next[field]
      return next
    })
  }

  const validate = () => {
    if (!selectedBoard) return false
    const fields = ["indexNumber", "examYear", "dob", "customerName", "customerEmail", "phoneNumber", "whatsappNumber"]
    if (mode === "own_voucher") fields.unshift("voucherPin", "voucherSerial")

    const errors: Record<string, string> = {}
    for (const f of fields) {
      const e = fieldError(f)
      if (e) errors[f] = e
    }
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async () => {
    if (!selectedBoard || !candidateType || !mode || !validate()) return
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
      // Step 1: Initialize the results-check request
      const initRes = await fetch("/api/shop/results-check/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSlug,
          examBoard: selectedBoard,
          candidateType,
          mode,
          indexNumber: formData.indexNumber.trim(),
          examYear: parseInt(formData.examYear),
          dob: formData.dob.trim(),
          voucherPin: mode === "own_voucher" ? formData.voucherPin.trim() : undefined,
          voucherSerial: mode === "own_voucher" ? formData.voucherSerial.trim() : undefined,
          customerName: formData.customerName,
          customerEmail: formData.customerEmail,
          phoneNumber: formData.phoneNumber.replace(/\s/g, ""),
          whatsappNumber: formData.whatsappNumber.trim() ? formData.whatsappNumber.replace(/\s/g, "") : undefined,
          // The MoMo number we charge on-page (direct charge) and/or OTP-verify.
          paymentPhone: (otpRequired || directCharge) ? paymentPhone.replace(/\s/g, "") : undefined,
          turnstileToken,
          website: honeypot,
        }),
      })
      const initData = await initRes.json()
      if (!initRes.ok) {
        toast.error(initData.error ?? "Failed to initialize request")
        return
      }

      // ── Direct MoMo charge path (direct-charge toggle ON) ────────────────
      if (directCharge) {
        const summary = {
          packageLabel: `${selectedBoard} Results Check (${mode === "combo" ? "voucher + check" : "own voucher"})`,
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
            orderType: "results_check_service",
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
          orderType: "results_check_service",
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

  const activeBoardInfo = selectedBoard ? boardInfo[selectedBoard] : null
  const totalPrice = mode === "combo" ? (activeBoardInfo?.comboPrice ?? 0) : (activeBoardInfo?.checkFee ?? 0)

  if (loadingPrices) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-violet-600" />
      </div>
    )
  }

  if (!serviceEnabled) {
    return (
      <div className="max-w-md mx-auto text-center py-12 space-y-2">
        <ClipboardCheck className="w-10 h-10 text-muted-foreground mx-auto" />
        <h3 className="font-bold text-foreground">Service unavailable</h3>
        <p className="text-sm text-muted-foreground">The Results Check Service is temporarily unavailable. Please check back later.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-2xl font-black mb-2 text-foreground border-l-4 border-violet-600 pl-4">Check My Results</h2>
        <p className="text-muted-foreground text-sm pl-5">We&apos;ll check your WASSCE, BECE or NOVDEC results for you and send them to your email &amp; WhatsApp</p>
      </div>

      {/* Board selection */}
      <div className="grid grid-cols-3 gap-4">
        {EXAM_BOARDS.map(board => {
          const info = boardInfo[board]
          if (!info) return null
          return (
            <Card
              key={board}
              onClick={() => selectBoard(board)}
              className={`group cursor-pointer transition-all duration-300 overflow-hidden border-0 ${
                !info.enabled
                  ? "opacity-40 cursor-not-allowed shadow-sm"
                  : selectedBoard === board
                  ? "ring-4 ring-violet-600 shadow-xl"
                  : "shadow-md hover:shadow-xl hover:-translate-y-1"
              }`}
            >
              <div className={`h-2 ${selectedBoard === board ? "bg-violet-600" : "bg-muted group-hover:bg-violet-300"} transition-colors`} />
              <CardContent className="pt-4 pb-4 text-center">
                <GraduationCap className={`w-8 h-8 mx-auto mb-2 ${selectedBoard === board ? "text-violet-600" : "text-muted-foreground"}`} />
                <p className={`font-black text-lg ${selectedBoard === board ? "text-violet-700" : "text-foreground"}`}>{board}</p>
                <p className="text-2xl font-black text-foreground mt-1">GHS {info.checkFee.toFixed(2)}</p>
                <p className="text-xs text-muted-foreground mt-1">checking fee</p>
                {!info.enabled && (
                  <p className="text-xs text-red-500 mt-1 font-medium">Unavailable</p>
                )}
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
          {/* Candidate type */}
          <div ref={candidateRef} className="scroll-mt-24">
            <Label className="text-sm font-semibold text-foreground">Candidate Type</Label>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {(["school", "private"] as const).map(ct => (
                <button
                  key={ct}
                  onClick={() => { setCandidateType(ct); scrollToRef(modeRef) }}
                  className={`p-4 rounded-xl border-2 font-semibold transition-colors ${
                    candidateType === ct
                      ? "border-violet-600 bg-violet-50 text-violet-700"
                      : "border-border text-foreground hover:border-violet-300"
                  }`}
                >
                  {ct === "school" ? "School Candidate" : "Private Candidate"}
                </button>
              ))}
            </div>
          </div>

          {/* Mode selection */}
          {candidateType && activeBoardInfo && (
            <div ref={modeRef} className="animate-in fade-in duration-300 scroll-mt-24">
              <Label className="text-sm font-semibold text-foreground">How would you like to pay?</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                <Card
                  onClick={() => { setMode("own_voucher"); scrollToRef(detailsRef) }}
                  className={`cursor-pointer transition-all duration-300 border-2 ${
                    mode === "own_voucher" ? "border-violet-600 ring-2 ring-violet-200" : "border-border hover:border-violet-300"
                  }`}
                >
                  <CardContent className="pt-4 pb-4">
                    <p className="font-bold text-foreground">I have my own voucher</p>
                    <p className="text-2xl font-black text-foreground mt-1">GHS {activeBoardInfo.checkFee.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground mt-1">Just the checking fee — you provide the PIN &amp; serial</p>
                  </CardContent>
                </Card>
                <Card
                  onClick={() => { if (activeBoardInfo.availableCount > 0) { setMode("combo"); scrollToRef(detailsRef) } }}
                  className={`transition-all duration-300 border-2 ${
                    activeBoardInfo.availableCount === 0
                      ? "opacity-40 cursor-not-allowed border-border"
                      : mode === "combo"
                      ? "cursor-pointer border-violet-600 ring-2 ring-violet-200"
                      : "cursor-pointer border-border hover:border-violet-300"
                  }`}
                >
                  <CardContent className="pt-4 pb-4">
                    <p className="font-bold text-foreground">Buy a voucher for me</p>
                    <p className="text-2xl font-black text-foreground mt-1">GHS {activeBoardInfo.comboPrice.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground mt-1">Voucher + checking fee, all in one</p>
                    {activeBoardInfo.availableCount === 0 && (
                      <p className="text-xs text-red-500 mt-1 font-medium">Out of stock — choose &quot;I have my own voucher&quot;</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {mode && (
            <div ref={detailsRef} className="space-y-6 animate-in fade-in duration-300 scroll-mt-24">
              {/* Own-voucher fields */}
              {mode === "own_voucher" && (
                <div className="space-y-4">
                  <h3 className="font-semibold text-foreground">Your Voucher Details</h3>
                  <div>
                    <Label className="text-sm">Voucher PIN</Label>
                    <Input
                      inputMode="numeric"
                      value={formData.voucherPin}
                      onChange={e => setFormData(p => ({ ...p, voucherPin: e.target.value.replace(/\D/g, "").slice(0, 12) }))}
                      onBlur={() => validateField("voucherPin")}
                      placeholder="12-digit PIN"
                      className={`mt-1 font-mono ${formErrors.voucherPin ? "border-red-400" : ""}`}
                    />
                    {formErrors.voucherPin && <p className="text-xs text-red-500 mt-1">{formErrors.voucherPin}</p>}
                  </div>
                  <div>
                    <Label className="text-sm">Voucher Serial Number</Label>
                    <Input
                      value={formData.voucherSerial}
                      onChange={e => setFormData(p => ({ ...p, voucherSerial: e.target.value.toUpperCase() }))}
                      onBlur={() => validateField("voucherSerial")}
                      placeholder="e.g. WR1234567"
                      className={`mt-1 font-mono ${formErrors.voucherSerial ? "border-red-400" : ""}`}
                    />
                    {formErrors.voucherSerial && <p className="text-xs text-red-500 mt-1">{formErrors.voucherSerial}</p>}
                  </div>
                </div>
              )}

              {/* Exam details */}
              <div className="space-y-4">
                <h3 className="font-semibold text-foreground">Exam Details</h3>
                <div>
                  <Label className="text-sm">Index Number</Label>
                  <Input
                    inputMode="numeric"
                    value={formData.indexNumber}
                    onChange={e => setFormData(p => ({ ...p, indexNumber: e.target.value.replace(/\D/g, "") }))}
                    onBlur={() => validateField("indexNumber")}
                    placeholder="e.g. 0070202043"
                    className={`mt-1 font-mono ${formErrors.indexNumber ? "border-red-400" : ""}`}
                  />
                  {formErrors.indexNumber
                    ? <p className="text-xs text-red-500 mt-1">{formErrors.indexNumber}</p>
                    : <p className="text-xs text-muted-foreground mt-1">{selectedBoard === "BECE" ? "10 or 12-digit index number" : "10-digit index number"}</p>}
                </div>
                <div>
                  <Label className="text-sm">Exam Year</Label>
                  <Input
                    inputMode="numeric"
                    value={formData.examYear}
                    onChange={e => setFormData(p => ({ ...p, examYear: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                    onBlur={() => validateField("examYear")}
                    placeholder={`e.g. ${new Date().getFullYear()}`}
                    className={`mt-1 ${formErrors.examYear ? "border-red-400" : ""}`}
                  />
                  {formErrors.examYear && <p className="text-xs text-red-500 mt-1">{formErrors.examYear}</p>}
                </div>
                <div>
                  <Label className="text-sm">Date of Birth</Label>
                  <Input
                    value={formData.dob}
                    onChange={e => setFormData(p => ({ ...p, dob: e.target.value }))}
                    onBlur={() => validateField("dob")}
                    placeholder="DD/MM/YYYY e.g. 15/06/2008"
                    className={`mt-1 ${formErrors.dob ? "border-red-400" : ""}`}
                  />
                  {formErrors.dob && <p className="text-xs text-red-500 mt-1">{formErrors.dob}</p>}
                </div>
              </div>

              {/* Contact details */}
              <div className="space-y-4">
                <h3 className="font-semibold text-foreground">Your Details</h3>
                <div>
                  <Label className="text-sm">Full Name</Label>
                  <Input value={formData.customerName} onChange={e => setFormData(p => ({ ...p, customerName: e.target.value }))}
                    onBlur={() => validateField("customerName")}
                    placeholder="e.g. Kwame Mensah" className={`mt-1 ${formErrors.customerName ? "border-red-400" : ""}`} />
                  {formErrors.customerName && <p className="text-xs text-red-500 mt-1">{formErrors.customerName}</p>}
                </div>
                <div>
                  <Label className="text-sm">Email Address</Label>
                  <Input type="email" value={formData.customerEmail} onChange={e => setFormData(p => ({ ...p, customerEmail: e.target.value }))}
                    onBlur={() => validateField("customerEmail")}
                    placeholder="e.g. kwame@example.com" className={`mt-1 ${formErrors.customerEmail ? "border-red-400" : ""}`} />
                  {formErrors.customerEmail
                    ? <p className="text-xs text-red-500 mt-1">{formErrors.customerEmail}</p>
                    : <p className="text-xs text-muted-foreground mt-1">Your results will be sent to this email address</p>}
                </div>
                <div>
                  <Label className="text-sm">Phone Number</Label>
                  <Input value={formData.phoneNumber} onChange={e => {
                      setFormData(p => ({ ...p, phoneNumber: e.target.value }))
                      if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode("") }
                    }}
                    onBlur={() => validateField("phoneNumber")}
                    placeholder="0XX XXX XXXX" className={`mt-1 ${formErrors.phoneNumber ? "border-red-400" : ""}`} />
                  {formErrors.phoneNumber && <p className="text-xs text-red-500 mt-1">{formErrors.phoneNumber}</p>}
                  <p className="text-xs text-muted-foreground mt-1">We&apos;ll send your payment confirmation to this number via SMS</p>
                </div>
                <div>
                  <Label className="text-sm">WhatsApp Number</Label>
                  <Input value={formData.whatsappNumber} onChange={e => setFormData(p => ({ ...p, whatsappNumber: e.target.value }))}
                    onBlur={() => validateField("whatsappNumber")}
                    placeholder="0XX XXX XXXX" className={`mt-1 ${formErrors.whatsappNumber ? "border-red-400" : ""}`} />
                  {formErrors.whatsappNumber
                    ? <p className="text-xs text-red-500 mt-1">{formErrors.whatsappNumber}</p>
                    : <p className="text-xs text-muted-foreground mt-1">We&apos;ll also send your results here as an image/PDF</p>}
                </div>
              </div>

              {/* Price summary */}
              <div className="bg-violet-50 rounded-xl p-4 space-y-2 text-sm border border-border">
                <div className="flex justify-between text-muted-foreground">
                  <span>{selectedBoard} results check{mode === "combo" ? " + voucher" : ""}</span>
                  <span>GHS {totalPrice.toFixed(2)}</span>
                </div>
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
                <div className="p-4 rounded-xl bg-purple-50 border border-border space-y-3">
                  <div>
                    <Label className="text-sm font-semibold text-purple-900">Mobile Money number to pay from</Label>
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
                    <p className="text-xs text-purple-700 mt-1">
                      {otpRequired ? "The payment prompt is sent to this number. You verify it once." : "The payment prompt is sent to this number."}
                    </p>
                  </div>

                  {otpRequired && (!otpVerified ? (
                    !otpSent ? (
                      <Button type="button" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full bg-purple-600 hover:bg-purple-700 text-white rounded-xl">
                        {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                      </Button>
                    ) : (
                      <div className="space-y-2">
                        <Input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otpCode}
                          onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          className="text-center text-lg tracking-[0.4em] font-mono bg-card" />
                        <div className="flex gap-2">
                          <Button type="button" onClick={handleVerifyOtp} disabled={verifyingOtp || otpCode.length < 4} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white rounded-xl">
                            {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                          </Button>
                          <Button type="button" variant="outline" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>{otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}</Button>
                        </div>
                        <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                      </div>
                    )
                  ) : (
                    <div className="p-3 rounded-xl bg-green-50 border border-border flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5 text-green-600" />
                      <span className="text-sm font-medium text-green-900">Payment number verified ✓</span>
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
                className="w-full h-14 bg-slate-900 hover:bg-violet-700 text-white font-black rounded-xl shadow-xl transition-all duration-300 text-base"
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
                We&apos;ll check your results and send them to your email &amp; WhatsApp once ready
              </p>
            </div>
          )}
        </div>
      )}

      {/* Live Mobile Money prompt modal (direct-charge flow). */}
      {momoModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[60]">
          <Card className="w-full max-w-md bg-card rounded-2xl">
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
                  <CheckCircle2 className="w-9 h-9 text-green-600" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Payment successful 🎉</h3>
                  <p className="text-sm text-muted-foreground mt-1">Your request has been received. We&apos;ll check your results and send them to your email &amp; WhatsApp shortly. 📩 If you don&apos;t see the email, please check your Spam/Junk folder.</p>
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
                    window.location.href = `/shop/${shopSlug}/results-check/confirmation?reference=${momoModal.reference}&orderId=${momoModal.orderId}`
                  }}
                  className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 rounded-xl"
                >
                  View confirmation
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
                <Button variant="outline" onClick={() => setMomoModal(null)} className="w-full rounded-xl">Close</Button>
              </CardContent>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
