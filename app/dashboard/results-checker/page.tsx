"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@supabase/supabase-js"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  GraduationCap, Copy, CheckCircle, Clock, AlertCircle,
  Loader2, RefreshCw, Send, ChevronDown, ChevronUp, ShoppingCart, Download,
} from "lucide-react"
import { toast } from "sonner"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const EXAM_BOARDS = ["WAEC", "BECE", "NOVDEC"]

const STATUS_CLASSES: Record<string, string> = {
  pending:         "bg-yellow-100 text-yellow-800",
  pending_payment: "bg-purple-100 text-purple-700",
  completed:       "bg-green-100 text-green-700",
  failed:          "bg-red-100 text-red-700",
}

interface RCOrder {
  id: string
  reference_code: string
  exam_board: string
  quantity: number
  unit_price: number
  total_paid: number
  status: string
  created_at: string
  vouchers?: Array<{ pin: string; serial_number: string | null }>
}

interface BoardPricing {
  basePrice: number
  maxMarkup: number
  enabled: boolean
}

export default function ResultsCheckerPage() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)

  // Purchase form
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [examBoard, setExamBoard] = useState<string>("WAEC")
  const [quantity, setQuantity] = useState(1)
  const [shopId, setShopId] = useState<string | undefined>(undefined)
  const [pricing, setPricing] = useState<{ unitPrice: number; totalPaid: number } | null>(null)

  const [purchasing, setPurchasing] = useState(false)
  const [boardSettings, setBoardSettings] = useState<Record<string, BoardPricing>>({})

  // Success modal
  const [successOrder, setSuccessOrder] = useState<RCOrder | null>(null)
  const [successVouchers, setSuccessVouchers] = useState<Array<{ pin: string; serial_number: string | null }>>([])
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Order history
  const [orders, setOrders] = useState<RCOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null)
  const [resending, setResending] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.push("/auth/login"); return }
      setToken(data.session.access_token)
    })
  }, [router])

  useEffect(() => {
    if (!token) return
    loadWalletBalance()
    loadOrders()
    loadBoardSettings()
  }, [token])


  const loadWalletBalance = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from("wallets").select("balance").eq("user_id", user.id).single()
    setWalletBalance(data?.balance ?? 0)
  }

  const loadBoardSettings = async () => {
    const { data } = await supabase
      .from("admin_settings")
      .select("key, value")
      .like("key", "results_checker_%")

    const map: Record<string, any> = {}
    for (const row of data ?? []) map[row.key] = row.value

    const settings: Record<string, BoardPricing> = {}
    for (const board of EXAM_BOARDS) {
      const bk = board.toLowerCase()
      settings[board] = {
        basePrice: map[`results_checker_price_${bk}`]?.price ?? 0,
        maxMarkup: map[`results_checker_max_markup_${bk}`]?.max ?? 0,
        enabled: map[`results_checker_enabled_${bk}`]?.enabled !== false,
      }
    }
    setBoardSettings(settings)
  }

  // Derive pricing locally from boardSettings (no API call needed)
  useEffect(() => {
    const board = boardSettings[examBoard]
    if (board) {
      const unitPrice = board.basePrice
      setPricing({ unitPrice, totalPaid: parseFloat((unitPrice * quantity).toFixed(2)) })
    }
  }, [examBoard, quantity, boardSettings])

  const loadOrders = useCallback(async () => {
    if (!token) return
    setOrdersLoading(true)
    try {
      const res = await fetch("/api/results-checker/my-orders?limit=20", {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) setOrders(data.orders ?? [])
    } finally {
      setOrdersLoading(false)
    }
  }, [token])

  const handlePurchase = async () => {
    if (!token) return
    setPurchasing(true)
    try {
      const res = await fetch("/api/results-checker/purchase", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ examBoard, quantity, shopId }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 402) {
          toast.error(`Insufficient wallet balance. You need GHS ${data.required?.toFixed(2) ?? "more"} — please top up first.`)
        } else if (res.status === 409 && data.available !== undefined) {
          toast.error(
            data.available === 0
              ? `${examBoard} vouchers are currently out of stock.`
              : `Only ${data.available} ${examBoard} voucher${data.available !== 1 ? "s" : ""} left in stock — reduce your quantity.`
          )
        } else if (res.status === 409 && typeof data.error === "string" && data.error.includes("sold out")) {
          toast.error("Stock ran out at checkout — your wallet has been refunded automatically.")
        } else if (res.status === 503) {
          toast.error(`${examBoard} vouchers are not available right now. Try a different board.`)
        } else {
          toast.error(data.error ?? "Purchase failed. Please try again.")
        }
        return
      }
      setSuccessOrder({ ...data.order, vouchers: data.vouchers })
      setSuccessVouchers(data.vouchers ?? [])
      setWalletBalance(data.newBalance)
      setPurchaseOpen(false)
      setQuantity(1)
      loadOrders()
      toast.success(`${examBoard} voucher${quantity > 1 ? "s" : ""} purchased!`)
    } finally {
      setPurchasing(false)
    }
  }

  const handleCopyVoucher = (v: { pin: string; serial_number: string | null }, key: string) => {
    const text = `Serial: ${v.serial_number ?? "N/A"}\nPIN: ${v.pin}`
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    toast.success("Serial & PIN copied")
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const triggerExcelDownload = async (
    voucherList: Array<{ pin: string; serial_number: string | null }>,
    board: string,
    ref: string
  ) => {
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

  const handleResend = async (orderId: string, method: "sms" | "email") => {
    if (!token) return
    setResending(`${orderId}-${method}`)
    try {
      const res = await fetch(`/api/results-checker/my-orders/${orderId}/resend`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method }),
      })
      const data = await res.json()
      if (res.ok) toast.success(data.message)
      else toast.error(data.error ?? "Resend failed")
    } finally {
      setResending(null)
    }
  }

  const enabledBoards = EXAM_BOARDS.filter(b => boardSettings[b]?.enabled)

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <GraduationCap className="w-6 h-6 text-violet-600" />
              Results Checker Vouchers
            </h1>
            <p className="text-gray-500 text-sm mt-1">Purchase WAEC, BECE &amp; NOVDEC scratch card vouchers</p>
          </div>
          {walletBalance !== null && (
            <div className="text-right">
              <p className="text-xs text-gray-500">Wallet Balance</p>
              <p className="text-xl font-bold text-gray-900">GHS {walletBalance.toFixed(2)}</p>
            </div>
          )}
        </div>

        {/* Purchase Section */}
        <Card>
          <CardHeader className="pb-3 cursor-pointer" onClick={() => setPurchaseOpen(!purchaseOpen)}>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" />Buy Vouchers
              </CardTitle>
              {purchaseOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </div>
          </CardHeader>

          {purchaseOpen && (
            <CardContent className="space-y-4 pt-0">
              {/* Board selection */}
              <div>
                <Label className="text-sm font-medium">Exam Board</Label>
                <div className="grid grid-cols-3 gap-3 mt-2">
                  {EXAM_BOARDS.map(board => (
                    <button
                      key={board}
                      onClick={() => setExamBoard(board)}
                      disabled={!boardSettings[board]?.enabled}
                      className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed ${
                        examBoard === board
                          ? "border-violet-600 bg-violet-50 text-violet-700"
                          : "border-gray-200 hover:border-gray-300 text-gray-700"
                      }`}
                    >
                      <GraduationCap className="w-6 h-6 mb-1" />
                      {board}
                      {boardSettings[board] && (
                        <span className="text-xs font-normal text-gray-500 mt-1">
                          GHS {boardSettings[board].basePrice.toFixed(2)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quantity */}
              <div>
                <Label className="text-sm font-medium">Quantity</Label>
                <div className="flex items-center gap-3 mt-2">
                  <button onClick={() => setQuantity(q => Math.max(1, q - 1))}
                    className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center font-bold text-gray-700 hover:bg-gray-50">−</button>
                  <Input type="number" min="1" max="50" value={quantity}
                    onChange={e => setQuantity(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                    className="w-20 text-center font-bold text-lg" />
                  <button onClick={() => setQuantity(q => Math.min(50, q + 1))}
                    className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center font-bold text-gray-700 hover:bg-gray-50">+</button>
                </div>
              </div>

              {/* Price summary */}
              {pricing && (
                <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                  <div className="flex justify-between text-gray-600">
                    <span>Price per voucher</span>
                    <span>GHS {pricing.unitPrice.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Quantity</span>
                    <span>× {quantity}</span>
                  </div>
                  <div className="flex justify-between font-bold text-gray-900 text-base border-t pt-2">
                    <span>Total</span>
                    <span>GHS {pricing.totalPaid.toFixed(2)}</span>
                  </div>
                  {walletBalance !== null && pricing.totalPaid > walletBalance && (
                    <p className="text-red-600 text-xs font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />Insufficient balance. Top up your wallet first.
                    </p>
                  )}
                </div>
              )}

              <Button
                onClick={handlePurchase}
                disabled={purchasing || (walletBalance !== null && pricing !== null && pricing.totalPaid > walletBalance) || !enabledBoards.includes(examBoard)}
                className="w-full h-12 font-bold"
              >
                {purchasing
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing…</>
                  : `Buy ${quantity} ${examBoard} Voucher${quantity > 1 ? "s" : ""} — GHS ${pricing?.totalPaid.toFixed(2) ?? "…"}`
                }
              </Button>
            </CardContent>
          )}
        </Card>

        {/* Success Modal */}
        {successOrder && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
              {/* Header */}
              <div className="text-center px-6 pt-6 pb-3 flex-shrink-0">
                <div className="text-4xl mb-2">🎓</div>
                <h2 className="text-lg font-bold text-green-700">Vouchers Delivered!</h2>
                <p className="text-sm text-gray-500 mt-0.5">Ref: {successOrder.reference_code}</p>
              </div>

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto px-6 pb-2 space-y-3">
                <div className="flex justify-end">
                  <button
                    onClick={() => triggerExcelDownload(successVouchers, successOrder.exam_board, successOrder.reference_code)}
                    className="flex items-center gap-1.5 text-xs text-violet-600 hover:text-violet-700 font-medium"
                  >
                    <Download className="w-3.5 h-3.5" />Download receipt
                  </button>
                </div>
                <div className="space-y-2">
                  {successVouchers.map((v, i) => (
                    <div key={i} className="flex items-start justify-between bg-gray-50 rounded-xl px-4 py-3 gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-500 font-medium mb-1">Voucher {i + 1}</p>
                        <p className="text-xs text-gray-400">Serial Number</p>
                        <p className="font-mono font-semibold text-gray-700 text-sm break-all">{v.serial_number ?? "N/A"}</p>
                        <p className="text-xs text-gray-400 mt-1">PIN</p>
                        <p className="font-mono font-bold text-gray-900 tracking-widest text-lg break-all">{v.pin}</p>
                      </div>
                      <button onClick={() => handleCopyVoucher(v, `success-${i}`)}
                        className="flex-shrink-0 p-2 border border-gray-200 hover:bg-gray-200 rounded-lg transition-colors mt-1">
                        {copiedKey === `success-${i}`
                          ? <CheckCircle className="w-4 h-4 text-green-600" />
                          : <Copy className="w-4 h-4 text-gray-500" />}
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 text-center">These vouchers have also been sent to your phone &amp; email.</p>
              </div>

              {/* Sticky footer */}
              <div className="px-6 pb-6 pt-3 flex-shrink-0">
                <Button onClick={() => setSuccessOrder(null)} className="w-full h-12 text-base">Done</Button>
              </div>
            </div>
          </div>
        )}

        {/* Order History */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900">Order History</h2>
            <Button variant="outline" size="sm" onClick={loadOrders}>
              <RefreshCw className="w-4 h-4 mr-1" />Refresh
            </Button>
          </div>

          {ordersLoading ? (
            <div className="flex items-center justify-center h-32"><Loader2 className="w-6 h-6 animate-spin text-violet-600" /></div>
          ) : orders.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <GraduationCap className="w-10 h-10 mx-auto text-gray-300 mb-3" />
                <p className="text-gray-500">No vouchers purchased yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {orders.map(order => (
                <Card key={order.id} className="overflow-hidden">
                  <div
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
                    onClick={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="font-semibold">{order.exam_board}</Badge>
                      <span className="font-mono text-sm text-gray-600">{order.reference_code}</span>
                      <span className="text-sm text-gray-500">× {order.quantity}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold">GHS {Number(order.total_paid).toFixed(2)}</span>
                      <Badge className={STATUS_CLASSES[order.status] ?? ""}>{order.status}</Badge>
                      <span className="text-xs text-gray-400">{new Date(order.created_at).toLocaleDateString()}</span>
                      {expandedOrder === order.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>

                  {expandedOrder === order.id && (
                    <div className="border-t px-4 py-3 bg-gray-50 space-y-3">
                      {order.status === "completed" && order.vouchers && order.vouchers.length > 0 ? (
                        <>
                          <div className="flex justify-end">
                            <button
                              onClick={() => triggerExcelDownload(order.vouchers!, order.exam_board, order.reference_code)}
                              className="flex items-center gap-1.5 text-xs text-violet-600 hover:text-violet-700 font-medium"
                            >
                              <Download className="w-3.5 h-3.5" />Download receipt
                            </button>
                          </div>
                          <div className="space-y-2">
                            {order.vouchers.map((v, i) => (
                              <div key={i} className="flex items-start justify-between bg-white rounded-lg px-3 py-2 border gap-3">
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-gray-400 mb-1">Voucher {i + 1}</p>
                                  <p className="text-xs text-gray-400">Serial Number</p>
                                  <p className="font-mono font-semibold text-gray-700 text-sm">{v.serial_number ?? "N/A"}</p>
                                  <p className="text-xs text-gray-400 mt-1">PIN</p>
                                  <p className="font-mono font-bold tracking-widest text-base">{v.pin}</p>
                                </div>
                                <button onClick={() => handleCopyVoucher(v, `${order.id}-${i}`)} className="flex-shrink-0 p-2 border border-gray-200 hover:bg-gray-100 rounded-lg mt-1">
                                  {copiedKey === `${order.id}-${i}`
                                    ? <CheckCircle className="w-4 h-4 text-green-600" />
                                    : <Copy className="w-4 h-4 text-gray-500" />}
                                </button>
                              </div>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <Button variant="outline" size="sm"
                              disabled={resending === `${order.id}-sms`}
                              onClick={() => handleResend(order.id, "sms")}>
                              {resending === `${order.id}-sms` ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                              Resend SMS
                            </Button>
                            <Button variant="outline" size="sm"
                              disabled={resending === `${order.id}-email`}
                              onClick={() => handleResend(order.id, "email")}>
                              {resending === `${order.id}-email` ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                              Resend Email
                            </Button>
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-gray-500 italic">
                          {order.status === "pending_payment" ? "Awaiting payment…" : "Voucher details not available"}
                        </p>
                      )}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
