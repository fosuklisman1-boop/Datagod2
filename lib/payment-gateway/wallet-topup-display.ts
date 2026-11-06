// What the wallet top-up screen says for each gateway. Hubtel adds its own fee on top and its rate isn't fixed in our
// config (live 2026-11-05: 0.01 on 1.00, 0.10 on 5.00), so the screen promises no percentage on Hubtel.
import type { Gateway } from "./config"

export interface WalletTopupDisplay {
  description: string
  feeLabel: string
  feeValue: string
  totalLabel: string
  totalValue: string
  feeNote: string
  payButton: string
}

const ghs = (n: number) => `GHS ${n.toFixed(2)}`

export function walletTopupDisplay(i: { amount: number; gateway: Gateway; paystackFeePercent: number }): WalletTopupDisplay {
  const amount = Number.isFinite(i.amount) ? i.amount : 0
  if (i.gateway === "hubtel") {
    const total = `${ghs(amount)} + fee`
    return {
      description: "Add funds to your wallet using Mobile Money with Hubtel",
      feeLabel: "Hubtel Fee:",
      feeValue: "Added at payment",
      totalLabel: "Total Amount:",
      totalValue: total,
      feeNote: HUBTEL_FEE_NOTE,
      payButton: `Pay ${total}`,
    }
  }
  const pct = i.paystackFeePercent
  const total = ghs(amount * (1 + pct / 100))
  return {
    description: "Add funds to your wallet using Paystack",
    feeLabel: `Paystack Fee (${pct}%):`,
    feeValue: ghs((amount * pct) / 100),
    totalLabel: "Total Amount:",
    totalValue: total,
    feeNote: `The ${pct}% fee is charged by Paystack for payment processing.`,
    payButton: `Pay ${total}`,
  }
}

export const HUBTEL_FEE_NOTE = "Hubtel adds its fee on top. Check the total on your MoMo prompt before you approve."

/** The initialize reply moved to Paystack after a Hubtel refusal: what the customer is really being asked for. */
export function fallbackChargeNotice(reply: unknown): string | null {
  const amount = (reply as { chargedAmount?: unknown } | null)?.chargedAmount
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null
  return `This payment moved to Paystack. The total is ${ghs(amount)}, including its fee. Check it on your prompt before you approve.`
}

/** The pay button on a checkout that shows a plain price. */
export function gatewayPayLabel(i: { amount: number; gateway: Gateway; direct: boolean }): string {
  if (i.gateway === "hubtel") return `Pay ${ghs(i.amount)} + fee`
  return i.direct ? `Pay ${ghs(i.amount)}` : `Pay ${ghs(i.amount)} with Paystack`
}

/**
 * Should the storefront forms show their verify step? Hubtel direct needs a verified number even with the OTP gate off.
 * These forms write the order before the payment starts, so asking up front is what stops an unpaid order being left behind.
 */
export function storefrontOtpStep(i: { otpRequired: boolean; gateway: Gateway; direct: boolean }): boolean {
  return i.otpRequired || (i.gateway === "hubtel" && i.direct)
}

/** The server wants this number verified first (Hubtel's no-unsolicited-prompts rule), even with the OTP gate off. */
export function isOtpRequiredReply(status: number, body: unknown): boolean {
  return status === 403 && (body as { code?: unknown } | null)?.code === "OTP_REQUIRED"
}
