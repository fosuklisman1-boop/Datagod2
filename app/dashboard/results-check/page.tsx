"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ClipboardCheck, GraduationCap, Loader2, CheckCircle2, AlertCircle, Wallet, Smartphone,
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
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

interface BoardInfo {
  enabled: boolean
  checkFee: number       // own_voucher total — base check fee (no markup)
  comboPrice: number     // combo total — check fee + voucher base price
  availableCount: number
}

type CandidateType = "school" | "private"
type CheckMode = "combo" | "own_voucher"
type PayFrom = "wallet" | "momo"

interface SuccessInfo {
  reference: string
  whatsappNumber: string
  total: number
  mode: CheckMode
  examBoard: ExamBoard
  paidVia: PayFrom
}

export default function DashboardResultsCheckPage() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string>("")
  const [walletBalance, setWalletBalance] = useState<number | null>(null)

  // Pricing / availability
  const [serviceEnabled, setServiceEnabled] = useState(true)
  const [loadingPrices, setLoadingPrices] = useState(true)
  const [boardInfo, setBoardInfo] = useState<Record<string, BoardInfo>>({})

  // Form selections (progressive disclosure)
  const [selectedBoard, setSelectedBoard] = useState<ExamBoard | null>(null)
  const [candidateType, setCandidateType] = useState<CandidateType | null>(null)
  const [mode, setMode] = useState<CheckMode | null>(null)
  const [payFrom, setPayFrom] = useState<PayFrom>("wallet")

  const [formData, setFormData] = useState({
    voucherPin: "",
    voucherSerial: "",
    indexNumber: "",
    examYear: "",
    dob: "",
    whatsappNumber: "",
    paymentPhone: "",
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  // Live "approve the prompt" modal for the MoMo flow
  const [momoModal, setMomoModal] = useState<null | {
    state: "awaiting" | "success" | "failed"
    orderId?: string
    reference?: string
    summary?: { label: string; paymentPhone: string; amount: number; whatsappNumber: string }
    message?: string
  }>(null)

  // Success screen (wallet path, or after MoMo completes)
  const [success, setSuccess] = useState<SuccessInfo | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.push("/auth/login"); return }
      setToken(data.session.access_token)
      setUserEmail(data.session.user.email ?? "")
    })
  }, [router])

  useEffect(() => {
    if (!token) return
    loadWalletBalance()
    loadBoardPricing()
  }, [token])

  const loadWalletBalance = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from("wallets").select("balance").eq("user_id", user.id).single()
    setWalletBalance(data?.balance ?? 0)
  }

  // Pricing mirrors the storefront, minus shop markup: dealer pays Datagod's BASE.
  // own_voucher total = results_check_settings.fee
  // combo total       = fee + results_checker_price_{board}.price
  const loadBoardPricing = async () => {
    setLoadingPrices(true)
    try {
      // admin_settings is service-role only; read curated config via the public API.
      const settingsMap: Record<string, any> = {}
      try {
        const cfgRes = await fetch("/api/public/config")
        if (cfgRes.ok) {
          const cfg = await cfgRes.json().catch(() => ({}))
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
      const baseCheckFee = parseFloat(rcSettings?.fee ?? 0) || 0

      // Combo inventory per board (anon key cannot read the inventory table).
      const availableCounts: Record<string, number> = { WASSCE: 0, BECE: 0, NOVDEC: 0 }
      try {
        const avRes = await fetch("/api/shop/results-checker/availability")
        if (avRes.ok) {
          const avData = await avRes.json().catch(() => ({}))
          Object.assign(availableCounts, avData.counts ?? {})
        }
      } catch (e) {
        console.warn("Could not load availability counts:", e)
      }

      const info: Record<string, BoardInfo> = {}
      for (const board of EXAM_BOARDS) {
        const bk = board.toLowerCase()
        const enabled = settingsMap[`results_checker_enabled_${bk}`]?.enabled !== false
        const voucherBase = parseFloat(settingsMap[`results_checker_price_${bk}`]?.price ?? 0) || 0
        info[board] = {
          enabled,
          checkFee: parseFloat(baseCheckFee.toFixed(2)),
          comboPrice: parseFloat((baseCheckFee + voucherBase).toFixed(2)),
          availableCount: availableCounts[board] ?? 0,
        }
      }
      setBoardInfo(info)

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
  }

  // Single source of truth for per-field error messages. Returns null when valid.
  const fieldError = (field: string): string | null => {
    switch (field) {
      case "voucherPin":
        if (!selectedBoard) return null
        return mode === "own_voucher" && !isValidVoucherPin(selectedBoard, formData.voucherPin.trim())
          ? (selectedBoard === "BECE" ? "Enter a valid voucher PIN (10–12 letters/digits)" : "Enter a valid 12-digit voucher PIN") : null
      case "voucherSerial":
        if (!selectedBoard) return null
        return mode === "own_voucher" && !isValidVoucherSerial(selectedBoard, formData.voucherSerial.trim())
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
      case "whatsappNumber":
        return !isValidGhanaPhone(formData.whatsappNumber.replace(/\s/g, ""))
          ? "Valid 10-digit WhatsApp number required" : null
      default:
        return null
    }
  }

  // Validate a single field on blur, so the user is told early.
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
    const fields = ["indexNumber", "examYear", "dob", "whatsappNumber"]
    if (mode === "own_voucher") fields.unshift("voucherPin", "voucherSerial")

    const errors: Record<string, string> = {}
    for (const f of fields) {
      const e = fieldError(f)
      if (e) errors[f] = e
    }
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  // Poll the request status while the live MoMo prompt modal is open.
  const pollMomoStatus = (orderId: string, reference: string, summary: any, info: SuccessInfo) => {
    const started = Date.now()
    const TIMEOUT_MS = 4 * 60 * 1000
    const tick = async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        setMomoModal({ state: "failed", message: "Payment timed out. If you approved the prompt, the request will still be processed — check the order, or try again." })
        return
      }
      try {
        const res = await fetch(`/api/payments/momo-status?orderId=${orderId}&orderType=results_check_service`)
        const d = await res.json().catch(() => ({ status: "pending" }))
        if (d.status === "completed") {
          setMomoModal(null)
          setSuccess(info)
          loadWalletBalance()
          return
        }
        if (d.status === "failed") { setMomoModal({ state: "failed", message: "Payment was not completed. Please try again." }); return }
      } catch { /* keep polling */ }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 3000)
  }

  const handleSubmit = async () => {
    if (!token) { toast.error("Your session expired. Please refresh and sign in again."); return }
    if (!selectedBoard || !candidateType || !mode || !validate()) return
    if (payFrom === "momo" && !/^0?\d{9}$/.test(formData.paymentPhone.replace(/\D/g, ""))) {
      toast.error("Enter a valid Mobile Money number to pay from")
      return
    }

    const activeInfo = boardInfo[selectedBoard]
    const total = mode === "combo" ? (activeInfo?.comboPrice ?? 0) : (activeInfo?.checkFee ?? 0)
    const whatsappNumber = formData.whatsappNumber.replace(/\s/g, "")

    if (payFrom === "wallet" && walletBalance !== null && total > walletBalance) {
      toast.error(`Insufficient wallet balance. You need GHS ${total.toFixed(2)} — please top up first.`)
      return
    }

    setSubmitting(true)
    try {
      // Step 1: Initialize the results-check request (authed dealer).
      const initRes = await fetch("/api/results-check/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          examBoard: selectedBoard,
          candidateType,
          mode,
          indexNumber: formData.indexNumber.trim(),
          examYear: parseInt(formData.examYear),
          dob: formData.dob.trim(),
          voucherPin: mode === "own_voucher" ? formData.voucherPin.trim() : undefined,
          voucherSerial: mode === "own_voucher" ? formData.voucherSerial.trim() : undefined,
          whatsappNumber,
          payFrom,
        }),
      })
      const initData = await initRes.json().catch(() => ({}))

      if (!initRes.ok) {
        if (initRes.status === 402) {
          toast.error(`Insufficient wallet balance. You need GHS ${Number(initData.required ?? total).toFixed(2)} — please top up first.`)
        } else {
          toast.error(initData.error ?? "Failed to initialize request. Please try again.")
        }
        return
      }

      // ── Wallet path: already charged + submitted server-side. ───────────────
      if (payFrom === "wallet") {
        if (typeof initData.newBalance === "number") setWalletBalance(initData.newBalance)
        setSuccess({
          reference: initData.reference,
          whatsappNumber,
          total: Number(initData.totalPrice ?? total),
          mode,
          examBoard: selectedBoard,
          paidVia: "wallet",
        })
        toast.success("Request submitted — paid from wallet")
        return
      }

      // ── MoMo path: request created (NOT paid). Start the direct charge. ─────
      const orderId = initData.orderId
      const totalPrice = Number(initData.totalPrice ?? total)
      const summary = {
        label: `${selectedBoard} Results Check (${mode === "combo" ? "voucher + check" : "own voucher"})`,
        paymentPhone: formData.paymentPhone.replace(/\s/g, ""),
        amount: totalPrice,
        whatsappNumber,
      }
      const chargeRes = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          email: userEmail,
          amount: totalPrice,
          orderId,
          orderType: "results_check_service",
          momoDirect: true,
          paymentPhone: formData.paymentPhone.replace(/\s/g, ""),
        }),
      })
      const chargeData = await chargeRes.json().catch(() => ({}))
      if (!chargeRes.ok || !chargeData.success) {
        toast.error(chargeData?.error ?? "Could not start the Mobile Money charge. Please try again.")
        return
      }

      const successInfo: SuccessInfo = {
        reference: chargeData.reference ?? initData.reference,
        whatsappNumber,
        total: totalPrice,
        mode,
        examBoard: selectedBoard,
        paidVia: "momo",
      }
      setMomoModal({ state: "awaiting", orderId, reference: chargeData.reference, summary })
      pollMomoStatus(orderId, chargeData.reference, summary, successInfo)
    } catch {
      toast.error("Something went wrong. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const resetForm = () => {
    setSuccess(null)
    setCandidateType(null)
    setMode(null)
    setPayFrom("wallet")
    setFormData({
      voucherPin: "", voucherSerial: "", indexNumber: "",
      examYear: "", dob: "", whatsappNumber: "", paymentPhone: "",
    })
    setFormErrors({})
  }

  const activeBoardInfo = selectedBoard ? boardInfo[selectedBoard] : null
  const totalPrice = mode === "combo" ? (activeBoardInfo?.comboPrice ?? 0) : (activeBoardInfo?.checkFee ?? 0)
  const insufficient = payFrom === "wallet" && walletBalance !== null && mode !== null && totalPrice > walletBalance
  const enabledBoards = EXAM_BOARDS.filter(b => boardInfo[b]?.enabled)

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <ClipboardCheck className="w-6 h-6 text-violet-600" />
              Results Check Service
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              We check a candidate&apos;s WASSCE, BECE or NOVDEC results on your behalf and deliver them to a WhatsApp number.
            </p>
          </div>
          {walletBalance !== null && (
            <div className="text-right flex-shrink-0">
              <p className="text-xs text-muted-foreground">Wallet Balance</p>
              <p className="text-xl font-bold text-foreground">GHS {walletBalance.toFixed(2)}</p>
            </div>
          )}
        </div>

        {loadingPrices ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-violet-600" />
          </div>
        ) : !serviceEnabled ? (
          <Card>
            <CardContent className="py-12 text-center space-y-2">
              <ClipboardCheck className="w-10 h-10 text-muted-foreground mx-auto" />
              <h3 className="font-bold text-foreground">Service unavailable</h3>
              <p className="text-sm text-muted-foreground">The Results Check Service is temporarily unavailable. Please check back later.</p>
            </CardContent>
          </Card>
        ) : success ? (
          /* ── Success screen ─────────────────────────────────────────────── */
          <Card>
            <CardContent className="py-10 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="w-9 h-9 text-green-600" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-green-700">Submitted!</h2>
                <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                  We&apos;ll check the results and send them to{" "}
                  <span className="font-semibold text-foreground">{success.whatsappNumber}</span> on WhatsApp shortly.
                </p>
              </div>
              <div className="text-left max-w-sm mx-auto p-4 rounded-xl bg-muted/40 border border-border space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Exam board</span><span className="font-medium">{success.examBoard}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Type</span><span className="font-medium">{success.mode === "combo" ? "Voucher + check" : "Own voucher"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Paid via</span><span className="font-medium">{success.paidVia === "wallet" ? "Wallet" : "Mobile Money"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold">GHS {success.total.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span className="font-mono text-xs">{success.reference}</span></div>
              </div>
              <Button onClick={resetForm} className="w-full max-w-sm mx-auto h-12">Check another candidate</Button>
            </CardContent>
          </Card>
        ) : (
          /* ── Form ───────────────────────────────────────────────────────── */
          <div className="space-y-6">
            {/* Board selection */}
            <div>
              <Label className="text-sm font-semibold text-foreground">Exam Board</Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
                {EXAM_BOARDS.map(board => {
                  const info = boardInfo[board]
                  if (!info) return null
                  return (
                    <button
                      key={board}
                      type="button"
                      onClick={() => selectBoard(board)}
                      disabled={!info.enabled}
                      className={`relative flex flex-col items-center p-4 rounded-xl border-2 transition-all font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed ${
                        selectedBoard === board
                          ? "border-violet-600 bg-violet-50 text-violet-700"
                          : "border-border hover:border-violet-300 text-foreground"
                      }`}
                    >
                      <GraduationCap className="w-6 h-6 mb-1" />
                      {board}
                      <span className="text-xs font-normal text-muted-foreground mt-1">
                        from GHS {info.checkFee.toFixed(2)}
                      </span>
                      {!info.enabled && <span className="text-xs text-red-500 mt-1 font-medium">Unavailable</span>}
                      {selectedBoard === board && (
                        <span className="absolute top-2 right-2"><CheckCircle2 className="w-4 h-4 text-violet-600" /></span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            {selectedBoard && (
              <div className="space-y-6 animate-in fade-in duration-300">
                {/* Candidate type */}
                <div>
                  <Label className="text-sm font-semibold text-foreground">Candidate Type</Label>
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    {(["school", "private"] as const).map(ct => (
                      <button
                        key={ct}
                        type="button"
                        onClick={() => setCandidateType(ct)}
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
                  <div className="animate-in fade-in duration-300">
                    <Label className="text-sm font-semibold text-foreground">Voucher Option</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                      <button
                        type="button"
                        onClick={() => setMode("own_voucher")}
                        className={`text-left p-4 rounded-xl border-2 transition-all ${
                          mode === "own_voucher" ? "border-violet-600 ring-2 ring-violet-200 bg-violet-50/50" : "border-border hover:border-violet-300"
                        }`}
                      >
                        <p className="font-bold text-foreground">Customer has their own voucher</p>
                        <p className="text-2xl font-black text-foreground mt-1">GHS {activeBoardInfo.checkFee.toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground mt-1">Just the checking fee — you enter the PIN &amp; serial</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => { if (activeBoardInfo.availableCount > 0) setMode("combo") }}
                        disabled={activeBoardInfo.availableCount === 0}
                        className={`text-left p-4 rounded-xl border-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                          mode === "combo" ? "border-violet-600 ring-2 ring-violet-200 bg-violet-50/50" : "border-border hover:border-violet-300"
                        }`}
                      >
                        <p className="font-bold text-foreground">We supply the voucher</p>
                        <p className="text-2xl font-black text-foreground mt-1">GHS {activeBoardInfo.comboPrice.toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground mt-1">Voucher + checking fee, all in one</p>
                        {activeBoardInfo.availableCount === 0 && (
                          <p className="text-xs text-red-500 mt-1 font-medium">Out of stock — choose &quot;own voucher&quot;</p>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {mode && (
                  <div className="space-y-6 animate-in fade-in duration-300">
                    {/* Own-voucher fields */}
                    {mode === "own_voucher" && (
                      <div className="space-y-4">
                        <h3 className="font-semibold text-foreground">Voucher Details</h3>
                        <div>
                          <Label className="text-sm">Voucher PIN</Label>
                          <Input
                            value={formData.voucherPin}
                            onChange={e => setFormData(p => ({
                              ...p,
                              voucherPin: selectedBoard === "BECE"
                                ? e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12)
                                : e.target.value.replace(/\D/g, "").slice(0, 12),
                            }))}
                            onBlur={() => validateField("voucherPin")}
                            placeholder={selectedBoard === "BECE" ? "e.g. 5FBR336742D4" : "12-digit PIN"}
                            className={`mt-1 font-mono ${formErrors.voucherPin ? "border-red-400" : ""}`}
                          />
                          {formErrors.voucherPin
                            ? <p className="text-xs text-red-500 mt-1">{formErrors.voucherPin}</p>
                            : <p className="text-xs text-muted-foreground mt-1">{selectedBoard === "BECE" ? "BECE PIN is alphanumeric (e.g. 5FBR336742D4)" : "WASSCE/NOVDEC PIN is 12 digits"}</p>}
                        </div>
                        <div>
                          <Label className="text-sm">Voucher Serial Number</Label>
                          <Input
                            value={formData.voucherSerial}
                            onChange={e => setFormData(p => ({
                              ...p,
                              voucherSerial: selectedBoard === "BECE"
                                ? e.target.value.replace(/\D/g, "").slice(0, 14)
                                : e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                            }))}
                            onBlur={() => validateField("voucherSerial")}
                            placeholder={selectedBoard === "BECE" ? "e.g. 252100270719" : "e.g. WGR1900112581"}
                            className={`mt-1 font-mono ${formErrors.voucherSerial ? "border-red-400" : ""}`}
                          />
                          {formErrors.voucherSerial
                            ? <p className="text-xs text-red-500 mt-1">{formErrors.voucherSerial}</p>
                            : <p className="text-xs text-muted-foreground mt-1">{selectedBoard === "BECE" ? "BECE serial is numeric (e.g. 252100270719)" : "WASSCE/NOVDEC serial is letter-prefixed (e.g. WGR1900112581)"}</p>}
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

                    {/* Delivery */}
                    <div className="space-y-4">
                      <h3 className="font-semibold text-foreground">Delivery</h3>
                      <div>
                        <Label className="text-sm">Deliver results to this WhatsApp number</Label>
                        <Input
                          inputMode="numeric"
                          value={formData.whatsappNumber}
                          onChange={e => setFormData(p => ({ ...p, whatsappNumber: e.target.value }))}
                          onBlur={() => validateField("whatsappNumber")}
                          placeholder="0XX XXX XXXX"
                          className={`mt-1 ${formErrors.whatsappNumber ? "border-red-400" : ""}`}
                        />
                        {formErrors.whatsappNumber
                          ? <p className="text-xs text-red-500 mt-1">{formErrors.whatsappNumber}</p>
                          : <p className="text-xs text-muted-foreground mt-1">We&apos;ll send the results to this WhatsApp number once ready</p>}
                      </div>
                    </div>

                    {/* Payment method */}
                    <div className="space-y-3">
                      <h3 className="font-semibold text-foreground">Payment</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setPayFrom("wallet")}
                          className={`flex items-center gap-2 p-4 rounded-xl border-2 font-semibold transition-colors ${
                            payFrom === "wallet"
                              ? "border-violet-600 bg-violet-50 text-violet-700"
                              : "border-border text-foreground hover:border-violet-300"
                          }`}
                        >
                          <Wallet className="w-5 h-5" />
                          <span className="text-left">
                            <span className="block text-sm">Wallet</span>
                            {walletBalance !== null && <span className="block text-xs font-normal text-muted-foreground">GHS {walletBalance.toFixed(2)}</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPayFrom("momo")}
                          className={`flex items-center gap-2 p-4 rounded-xl border-2 font-semibold transition-colors ${
                            payFrom === "momo"
                              ? "border-violet-600 bg-violet-50 text-violet-700"
                              : "border-border text-foreground hover:border-violet-300"
                          }`}
                        >
                          <Smartphone className="w-5 h-5" />
                          <span className="text-left">
                            <span className="block text-sm">Mobile Money</span>
                            <span className="block text-xs font-normal text-muted-foreground">Approve on phone</span>
                          </span>
                        </button>
                      </div>

                      {payFrom === "momo" && (
                        <div>
                          <Label className="text-sm">Mobile Money number to pay from</Label>
                          <Input
                            inputMode="numeric"
                            value={formData.paymentPhone}
                            onChange={e => setFormData(p => ({ ...p, paymentPhone: e.target.value }))}
                            placeholder="0241234567"
                            className="mt-1 font-mono"
                          />
                          <p className="text-xs text-muted-foreground mt-1">The payment prompt is sent to this number.</p>
                        </div>
                      )}
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
                      {insufficient && (
                        <p className="text-red-600 text-xs font-medium flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />Insufficient wallet balance. Top up first or pay with Mobile Money.
                        </p>
                      )}
                    </div>

                    <Button
                      onClick={handleSubmit}
                      disabled={
                        submitting ||
                        insufficient ||
                        !enabledBoards.includes(selectedBoard) ||
                        (payFrom === "momo" && !/^0?\d{9}$/.test(formData.paymentPhone.replace(/\D/g, "")))
                      }
                      className="w-full h-14 font-black rounded-xl text-base"
                    >
                      {submitting
                        ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Processing…</>
                        : payFrom === "wallet"
                          ? `Pay GHS ${totalPrice.toFixed(2)} from wallet`
                          : `Pay GHS ${totalPrice.toFixed(2)} with Mobile Money`
                      }
                    </Button>

                    <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      We&apos;ll check the results and send them to the WhatsApp number once ready — they are not shown instantly.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Live Mobile Money prompt modal (MoMo flow). */}
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
    </DashboardLayout>
  )
}
