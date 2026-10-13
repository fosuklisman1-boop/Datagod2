"use client"

import { SmsShell } from "../_components/SmsShell"
import { RecordsList } from "../_components/records/RecordsList"

export default function SmsRecordsPage() {
  return (
    <SmsShell backToHome subtitle="Records">
      <RecordsList />
    </SmsShell>
  )
}
