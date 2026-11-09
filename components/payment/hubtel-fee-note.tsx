"use client"

import { useEffect, useState } from "react"
import type { Gateway } from "@/lib/payment-gateway/config"
import { HUBTEL_FEE_NOTE } from "@/lib/payment-gateway/wallet-topup-display"

type StatusField = "storefront_gateway" | "dashboard_gateway" | "sms_gateway"

/** Which gateway a checkout should describe. Display only: starts on Paystack, and a failed read stays there. */
export function useSurfaceGateway(field: StatusField): Gateway {
  const [gateway, setGateway] = useState<Gateway>("paystack")
  useEffect(() => {
    let live = true
    fetch("/api/public/turnstile-status")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (live) setGateway(d?.[field] === "hubtel" ? "hubtel" : "paystack") })
      .catch(() => {})
    return () => { live = false }
  }, [field])
  return gateway
}

/** The note for a screen that doesn't otherwise need to know the gateway. */
export function SurfaceFeeNote({ field }: { field: StatusField }) {
  return <HubtelFeeNote gateway={useSurfaceGateway(field)} />
}

export function HubtelFeeNote({ gateway }: { gateway: Gateway }) {
  if (gateway !== "hubtel") return null
  return <p className="text-xs text-muted-foreground">{HUBTEL_FEE_NOTE}</p>
}
