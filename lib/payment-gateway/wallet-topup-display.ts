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
      feeNote: "Hubtel adds its fee on top. Check the total on your MoMo prompt before you approve.",
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

/** The server wants this number verified first (Hubtel's no-unsolicited-prompts rule), even with the OTP gate off. */
export function isOtpRequiredReply(status: number, body: unknown): boolean {
  return status === 403 && (body as { code?: unknown } | null)?.code === "OTP_REQUIRED"
}
