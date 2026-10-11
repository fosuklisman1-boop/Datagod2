"use client"

import { use } from "react"
import { SmsShell } from "../../_components/SmsShell"
import { RecordDetail } from "../../_components/records/RecordDetail"

export default function SmsRecordDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <SmsShell backToHome>
      <RecordDetail id={id} />
    </SmsShell>
  )
}
