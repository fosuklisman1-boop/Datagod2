"use client"

import { useState } from "react"
import { SmsShell } from "../_components/SmsShell"
import { BundleCards } from "../_components/credits/BundleCards"
import { CreditHistory } from "../_components/credits/CreditHistory"

export default function SmsCreditsPage() {
  const [refreshKey, setRefreshKey] = useState(0)
  return (
    <SmsShell backToHome subtitle="Credits">
      <BundleCards onPurchased={() => setRefreshKey((k) => k + 1)} />
      <CreditHistory refreshKey={refreshKey} />
    </SmsShell>
  )
}
