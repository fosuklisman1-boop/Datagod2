"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, Search, Send } from "lucide-react"
import { toast } from "sonner"

interface VoucherOrder {
  id: string
  reference_code: string
  exam_board: string
  quantity: number
  total_paid: number
  created_at: string
  customer_phone: string | null
}

export function VoucherLookup() {
  const [phone, setPhone] = useState("")
  const [reference, setReference] = useState("")
  const [orders, setOrders] = useState<VoucherOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  async function lookup(mode: "phone" | "reference") {
    const body = mode === "phone" ? { phone } : { reference }
    setLoading(true)
    setSearched(false)
    setOrders([])
    try {
      const res = await fetch("/api/public/vouchers/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? "Lookup failed.")
        return
      }
      setOrders(data.orders ?? [])
      setSearched(true)
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function resend(orderId: string) {
    setResending(orderId)
    try {
      const res = await fetch("/api/public/vouchers/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message ?? "Vouchers sent by SMS.")
      } else {
        toast.error(data.error ?? "Resend failed.")
      }
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setResending(null)
    }
  }

  function OrderList() {
    if (!searched) return null
    if (orders.length === 0) {
      return (
        <p className="text-sm text-muted-foreground text-center py-6">
          No completed voucher orders found.
        </p>
      )
    }
    return (
      <div className="space-y-3 mt-4">
        {orders.map(order => (
          <div key={order.id} className="flex items-center justify-between rounded-xl border px-4 py-3 gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline">{order.exam_board}</Badge>
                <span className="font-mono text-xs font-semibold">{order.reference_code}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {order.quantity} voucher{order.quantity !== 1 ? "s" : ""} · GHS {Number(order.total_paid).toFixed(2)} ·{" "}
                {new Date(order.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              </p>
              {order.customer_phone && (
                <p className="text-xs text-muted-foreground">SMS to: {order.customer_phone}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => resend(order.id)}
              disabled={resending === order.id}
              className="shrink-0"
            >
              {resending === order.id
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <><Send className="w-3 h-3 mr-1" />Resend SMS</>
              }
            </Button>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">Find your order</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Look up your results checker PINs and resend them by SMS.</p>
      </div>

      <Tabs defaultValue="phone">
        <TabsList className="w-full mb-4">
          <TabsTrigger value="phone" className="flex-1">By Phone Number</TabsTrigger>
          <TabsTrigger value="reference" className="flex-1">By Reference</TabsTrigger>
        </TabsList>

        <TabsContent value="phone" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Enter the phone number you used to make the purchase.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. 0244123456"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              onKeyDown={e => e.key === "Enter" && lookup("phone")}
              maxLength={15}
            />
            <Button onClick={() => lookup("phone")} disabled={!phone.trim() || loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </Button>
          </div>
          <OrderList />
        </TabsContent>

        <TabsContent value="reference" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Enter the reference code from your delivery SMS (e.g. RC-ABC-123).
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="RC-XXX-XXX"
              value={reference}
              onChange={e => setReference(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && lookup("reference")}
              maxLength={12}
            />
            <Button onClick={() => lookup("reference")} disabled={!reference.trim() || loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </Button>
          </div>
          <OrderList />
        </TabsContent>
      </Tabs>

      <p className="text-xs text-center text-muted-foreground">
        Vouchers are resent to the phone number used at checkout.
      </p>
    </div>
  )
}
