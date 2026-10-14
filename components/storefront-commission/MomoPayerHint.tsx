"use client"

import { momoNetworkLabel } from "@/lib/storefront-commission/ui-helpers"

export const NOT_MOMO = "Enter a Mobile Money number (MTN, Telecel or AT) to pay from."

/** Under the payer phone when the storefront pays by on-page Mobile Money prompt: which network gets the prompt. */
export function MomoPayerHint({ phone }: { phone: string }) {
  const network = momoNetworkLabel(phone)
  return (
    <p className="text-xs text-muted-foreground">
      {network
        ? <>The payment prompt is sent to this number ({network}).</>
        : "The payment prompt is sent to this Mobile Money number."}
    </p>
  )
}
