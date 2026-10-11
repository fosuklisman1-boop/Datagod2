"use client"

import { SmsShell } from "../_components/SmsShell"
import { BundleCards } from "../_components/credits/BundleCards"
import { CreditHistory } from "../_components/credits/CreditHistory"

export default function SmsCreditsPage() {
  return (
    <SmsShell backToHome subtitle="Credits">
      <BundleCards />
      <CreditHistory />
    </SmsShell>
  )
}
