"use client"

import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { CheckCircle2, XCircle, Copy, Loader2, ClipboardCheck, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useShopBasePath } from "@/lib/shop-url"
import { toast } from "sonner"

export default function ResultsCheckConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const shopSlug = params.slug as string
  const shopHome = useShopBasePath(shopSlug) || "/"
  const orderId = searchParams.get("orderId")
  const reference = searchParams.get("reference")

  const [checkRequest, setCheckRequest] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (orderId) pollRequest()
    else setLoading(false) // no orderId in URL — show error state instead of spinning forever
  }, [orderId])

  const pollRequest = async () => {
    setLoading(true)
    // Verify payment first (triggers webhook if not already processed)
    if (reference) {
      await fetch("/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference }),
      }).catch(() => {})
    }

    // Poll up to 10 times (~15 seconds) via server-side API — anon key is
    // blocked by RLS on results_check_requests for unauthenticated guests
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500))

      try {
        const res = await fetch(
          `/api/shop/results-check/request-status?requestId=${orderId}&reference=${reference}`
        )
        if (!res.ok) continue
        const { request: requestData } = await res.json()

        if (requestData) {
          setCheckRequest(requestData)
          if (requestData.payment_status === "paid" || requestData.payment_status === "failed") break
        }
      } catch {
        // network hiccup — keep polling
      }
    }
    setLoading(false)
  }

  const handleCopy = () => {
    const text = `Serial: ${checkRequest?.voucher_serial ?? "N/A"}\nPIN: ${checkRequest?.voucher_pin}`
    navigator.clipboard.writeText(text)
    setCopied(true)
    toast.success("Serial & PIN copied")
    setTimeout(() => setCopied(false), 2000)
  }

  const isSuccess = checkRequest?.payment_status === "paid"
  const isFailed = checkRequest?.payment_status === "failed"
  const isPending = checkRequest?.payment_status === "pending_payment"
  const hasVoucher = isSuccess && checkRequest?.mode === "combo" && checkRequest?.voucher_pin

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-violet-400 mx-auto" />
          <p className="text-white font-medium">Confirming your payment…</p>
          <p className="text-slate-400 text-sm">Please wait, this takes a few seconds</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">

        {/* Header card */}
        <div className={`rounded-2xl p-8 text-center ${isSuccess ? "bg-green-600" : isFailed ? "bg-red-600" : isPending ? "bg-amber-500" : "bg-slate-700"}`}>
          {isSuccess ? (
            <CheckCircle2 className="w-16 h-16 text-white mx-auto mb-4" />
          ) : isFailed ? (
            <XCircle className="w-16 h-16 text-white mx-auto mb-4" />
          ) : isPending ? (
            <Clock className="w-16 h-16 text-white mx-auto mb-4" />
          ) : (
            <ClipboardCheck className="w-16 h-16 text-white mx-auto mb-4" />
          )}
          <h1 className="text-2xl font-black text-white">
            {isSuccess ? "Request Received!" : isFailed ? "Payment Failed" : isPending ? "Confirming Payment…" : "Processing…"}
          </h1>
          <p className="text-white/80 text-sm mt-1">
            {isSuccess
              ? `${checkRequest.exam_board} · Ref: ${checkRequest?.payment_reference}`
              : isFailed
              ? "Please contact support"
              : isPending
              ? "We couldn't confirm your payment yet"
              : "Waiting for confirmation"}
          </p>
        </div>

        {/* Success notice */}
        {isSuccess && (
          <div className="bg-green-50 border border-border rounded-xl p-4 text-sm text-green-800 space-y-1">
            <p className="font-semibold">We&apos;ll check your {checkRequest.exam_board} results ✓</p>
            <p>
              Once your results are out, we&apos;ll send them to your email
              {checkRequest.whatsapp_number ? " and WhatsApp" : ""}.
            </p>
            <p className="text-xs text-green-700 mt-1">📩 Don&apos;t see the email? Please check your Spam or Junk folder.</p>
            <p className="text-xs text-green-700 mt-1">No further action is needed from you.</p>
          </div>
        )}

        {/* Pending notice */}
        {isPending && (
          <div className="bg-amber-50 border border-border rounded-xl p-4 text-sm text-amber-800 space-y-1">
            <p>If money was deducted from your account, please wait a moment and refresh this page.</p>
            <p className="text-xs text-amber-600 mt-1">Still showing this after a few minutes? Contact support with your reference above.</p>
          </div>
        )}

        {/* Assigned voucher (combo mode) */}
        {hasVoucher && (
          <div className="space-y-3">
            <p className="text-white font-semibold text-sm px-1">Your Voucher</p>
            <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="space-y-1.5">
                    <div>
                      <p className="text-slate-500 text-xs">Serial Number</p>
                      <p className="font-mono font-bold text-white tracking-wider text-lg">
                        {checkRequest.voucher_serial ?? "N/A"}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs">PIN</p>
                      <p className="font-mono font-bold text-violet-300 tracking-widest text-xl">
                        {checkRequest.voucher_pin}
                      </p>
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleCopy}
                  className="flex-shrink-0 p-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors"
                  title="Copy serial & PIN"
                >
                  {copied
                    ? <CheckCircle2 className="w-5 h-5 text-green-400" />
                    : <Copy className="w-5 h-5 text-slate-300" />}
                </button>
              </div>
            </div>
            <p className="text-slate-500 text-xs text-center pt-1">
              Keep these safe — we&apos;ll also use them to check your results
            </p>
          </div>
        )}

        {/* Request summary */}
        {checkRequest && (
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 space-y-2 text-sm">
            <div className="flex justify-between text-slate-400">
              <span>Exam Board</span><span className="text-white font-semibold">{checkRequest.exam_board}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Index Number</span><span className="text-white font-semibold font-mono">{checkRequest.index_number}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Service</span>
              <span className="text-white font-semibold">
                {checkRequest.mode === "combo" ? "Voucher + Result Check" : "Result Check"}
              </span>
            </div>
            <div className="flex justify-between text-slate-400 border-t border-slate-700 pt-2">
              <span>Amount Paid</span><span className="text-white font-bold">GHS {Number(checkRequest.fee).toFixed(2)}</span>
            </div>
          </div>
        )}

        <Button
          onClick={() => window.location.href = shopHome}
          className="w-full bg-violet-600 hover:bg-violet-700 text-white font-bold h-12 rounded-xl"
        >
          Back to Store
        </Button>

        <p className="text-center text-xs text-slate-600">Powered by DATAGOD · Secure Transaction</p>
      </div>
    </div>
  )
}
