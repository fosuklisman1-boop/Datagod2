"use client"

import { useEffect, useState, useRef } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { createClient } from "@supabase/supabase-js"
import { CheckCircle2, XCircle, Copy, Download, Loader2, GraduationCap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface Voucher {
  pin: string
  serial_number: string | null
}

export default function ResultsCheckerConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const shopSlug = params.slug as string
  const orderId = searchParams.get("orderId")
  const reference = searchParams.get("reference")

  const [order, setOrder] = useState<any>(null)
  const [vouchers, setVouchers] = useState<Voucher[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<number | null>(null)
  const downloadTriggered = useRef(false)

  useEffect(() => {
    if (orderId) pollOrder()
  }, [orderId])

  const pollOrder = async () => {
    setLoading(true)
    // Verify payment first (triggers webhook if not already processed)
    if (reference) {
      await fetch("/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference }),
      }).catch(() => {})
    }

    // Poll up to 6 times (9 seconds) for the order to complete
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500))

      const { data: orderData } = await supabase
        .from("results_checker_orders")
        .select("*")
        .eq("id", orderId)
        .single()

      if (orderData) {
        setOrder(orderData)
        if (orderData.status === "completed" && orderData.inventory_ids?.length) {
          const { data: inv } = await supabase
            .from("results_checker_inventory")
            .select("pin, serial_number")
            .in("id", orderData.inventory_ids)
          const v = inv ?? []
          setVouchers(v)
          if (v.length > 0 && !downloadTriggered.current) {
            downloadTriggered.current = true
            setTimeout(() => triggerExcelDownload(orderData, v), 800)
          }
          break
        }
        if (orderData.status === "failed") break
      }
    }
    setLoading(false)
  }

  const triggerExcelDownload = async (ord: any, voucherList: Voucher[]) => {
    try {
      const { utils, write } = await import("xlsx")
      const rows = [
        ["DATAGOD — Results Checker Voucher Receipt"],
        [],
        ["Reference", ord.reference_code],
        ["Exam Board", ord.exam_board],
        ["Quantity", ord.quantity],
        ["Amount Paid", `GHS ${Number(ord.total_paid).toFixed(2)}`],
        ["Date", new Date(ord.created_at).toLocaleString()],
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
      a.download = `${ord.exam_board}-vouchers-${ord.reference_code}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.warn("Auto-download failed:", e)
    }
  }

  const handleCopy = (v: Voucher, idx: number) => {
    const text = `Serial: ${v.serial_number ?? "N/A"}\nPIN: ${v.pin}`
    navigator.clipboard.writeText(text)
    setCopied(idx)
    toast.success("Serial & PIN copied")
    setTimeout(() => setCopied(null), 2000)
  }

  const isSuccess = order?.status === "completed"
  const isFailed = order?.status === "failed"

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
        <div className={`rounded-2xl p-8 text-center ${isSuccess ? "bg-green-600" : isFailed ? "bg-red-600" : "bg-slate-700"}`}>
          {isSuccess ? (
            <CheckCircle2 className="w-16 h-16 text-white mx-auto mb-4" />
          ) : isFailed ? (
            <XCircle className="w-16 h-16 text-white mx-auto mb-4" />
          ) : (
            <GraduationCap className="w-16 h-16 text-white mx-auto mb-4" />
          )}
          <h1 className="text-2xl font-black text-white">
            {isSuccess ? "Vouchers Delivered!" : isFailed ? "Order Failed" : "Processing…"}
          </h1>
          <p className="text-white/80 text-sm mt-1">
            {isSuccess ? `${order.exam_board} · Ref: ${order?.reference_code}` : isFailed ? "Please contact support" : "Waiting for confirmation"}
          </p>
        </div>

        {/* Vouchers */}
        {isSuccess && vouchers.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <p className="text-white font-semibold text-sm">Your Voucher{vouchers.length > 1 ? "s" : ""}</p>
              <button
                onClick={() => triggerExcelDownload(order, vouchers)}
                className="flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-300 font-medium"
              >
                <Download className="w-3.5 h-3.5" />
                Download receipt
              </button>
            </div>

            {vouchers.map((v, i) => (
              <div key={i} className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-400 text-xs mb-2">Voucher {i + 1}</p>
                    <div className="space-y-1.5">
                      <div>
                        <p className="text-slate-500 text-xs">Serial Number</p>
                        <p className="font-mono font-bold text-white tracking-wider text-lg">
                          {v.serial_number ?? "N/A"}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500 text-xs">PIN</p>
                        <p className="font-mono font-bold text-violet-300 tracking-widest text-xl">
                          {v.pin}
                        </p>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleCopy(v, i)}
                    className="flex-shrink-0 p-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors mt-4"
                    title="Copy serial & PIN"
                  >
                    {copied === i
                      ? <CheckCircle2 className="w-5 h-5 text-green-400" />
                      : <Copy className="w-5 h-5 text-slate-300" />}
                  </button>
                </div>
              </div>
            ))}

            <p className="text-slate-500 text-xs text-center pt-1">
              Vouchers also sent to your email and phone · Keep these safe
            </p>
          </div>
        )}

        {/* Order summary */}
        {order && (
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 space-y-2 text-sm">
            <div className="flex justify-between text-slate-400">
              <span>Exam Board</span><span className="text-white font-semibold">{order.exam_board}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Quantity</span><span className="text-white font-semibold">{order.quantity}</span>
            </div>
            <div className="flex justify-between text-slate-400 border-t border-slate-700 pt-2">
              <span>Total Paid</span><span className="text-white font-bold">GHS {Number(order.total_paid).toFixed(2)}</span>
            </div>
          </div>
        )}

        <Button
          onClick={() => window.location.href = `/shop/${shopSlug}`}
          className="w-full bg-violet-600 hover:bg-violet-700 text-white font-bold h-12 rounded-xl"
        >
          Back to Store
        </Button>

        <p className="text-center text-xs text-slate-600">Powered by DATAGOD · Secure Transaction</p>
      </div>
    </div>
  )
}
