import Link from "next/link"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ComposeSender } from "./types"

interface Props {
  senders: ComposeSender[]
  value: string
  onChange: (v: string) => void
}

function senderLabel(s: ComposeSender) {
  return s.is_pool ? `${s.sender_id} (shared pool)` : `${s.sender_id} (your sender ID)`
}

export function SenderSelect({ senders, value, onChange }: Props) {
  const active = senders.filter((s) => s.local_status === "active")
  return (
    <div className="space-y-1.5">
      <Label className="text-muted-foreground">From (sender ID)</Label>
      <Select value={value || "default"} onValueChange={(v) => onChange(v === "default" ? "" : v)}>
        <SelectTrigger className="w-full sm:w-72"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Platform default{active[0] ? ` (${active[0].sender_id})` : ""}</SelectItem>
          {active.map((s) => (
            <SelectItem key={s.id} value={s.sender_id}>{senderLabel(s)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No approved sender IDs yet — request one in{" "}
          <Link href="/dashboard/sms/business" className="font-medium text-primary hover:underline">Business &amp; Sender ID</Link>.
          Messages use the platform default meanwhile.
        </p>
      )}
    </div>
  )
}
