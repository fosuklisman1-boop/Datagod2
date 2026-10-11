import Link from "next/link"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ComposeSender } from "./types"

interface Props {
  senders: ComposeSender[]
  value: string
  onChange: (v: string) => void
  /** What the server uses when none is chosen (null = platform default). */
  defaultSender: string | null
  platformSender: string | null
  /** Shared pool names (business-mode accounts only). */
  pool: string[]
}

export function SenderSelect({ senders, value, onChange, defaultSender, platformSender, pool }: Props) {
  const own = senders.filter((s) => s.local_status === "active" && !s.is_pool)
  const ownNames = new Set(own.map((s) => s.sender_id.toUpperCase()))
  const poolRows = senders.filter((s) => s.local_status === "active" && s.is_pool).map((s) => s.sender_id)
  const poolNames = Array.from(new Set([...pool, ...poolRows].map((p) => p.toUpperCase()))).filter((p) => !ownNames.has(p))
  const defaultLabel = defaultSender
    ? `Default (${defaultSender})`
    : `Platform default${platformSender ? ` (${platformSender})` : ""}`
  return (
    <div className="space-y-1.5">
      <Label htmlFor="sender-select" className="text-muted-foreground">From (sender ID)</Label>
      <Select value={value || "default"} onValueChange={(v) => onChange(v === "default" ? "" : v)}>
        <SelectTrigger id="sender-select" aria-label="From (sender ID)" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{defaultLabel}</SelectItem>
          {own.map((s) => (
            <SelectItem key={s.id} value={s.sender_id}>{s.sender_id} (your sender ID)</SelectItem>
          ))}
          {poolNames.map((p) => (
            <SelectItem key={`pool-${p}`} value={p}>{p} (shared pool)</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {own.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No approved sender IDs of your own yet — request one in{" "}
          <Link href="/dashboard/sms/business" className="font-medium text-primary hover:underline">Business &amp; Sender ID</Link>.
          Messages use the default meanwhile.
        </p>
      )}
    </div>
  )
}
