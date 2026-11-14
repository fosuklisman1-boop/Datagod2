"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { adminFetch, ApiError, TTB_API } from "./api"
import { outcomeLabel, segmentText, ttbErrorMessage } from "./format"

type TryResult = {
  readBy: "rules" | "ai" | null
  outcome: string
  reply: string | null
  shop?: { name: string; via: "code" | "pref" | "last"; status: string } | null
  creditsToReserve?: number | null
}
const VIA_LABEL = { code: "named in the text", pref: "remembered for this number", last: "last purchase" } as const

export function TryItTab() {
  const [line, setLine] = useState<"main" | "shop">("main")
  const [sender, setSender] = useState("")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TryResult | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await adminFetch<TryResult>(`${TTB_API}/try`, { method: "POST", body: { line, sender: sender.trim(), text } }))
    } catch (e) {
      setError(ttbErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      setBusy(false)
    }
  }

  const seg = result?.reply ? segmentText(result.reply) : null
  const canRun = sender.trim() !== "" && text.trim() !== "" && !busy

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Nothing is sent and nobody is charged.</p>
            <p>If you type a real customer&apos;s number, you will see that customer&apos;s own conversation, last order and status, exactly as they would.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="ttb-try-line">Line</label>
            <select
              id="ttb-try-line"
              value={line}
              onChange={(e) => {
                setLine(e.target.value as "main" | "shop")
                setResult(null)
              }}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="main">Main line</option>
              <option value="shop">Shop line</option>
            </select>
            {line === "shop" && <p className="text-[11px] text-muted-foreground">Put a shop code in the text, e.g. kofi123 5gb. Shows which shop would be used and the credits it would reserve.</p>}
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="ttb-try-sender">Sender number</label>
            <Input id="ttb-try-sender" inputMode="tel" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="0200000101" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="ttb-try-text">Text message</label>
            <Textarea id="ttb-try-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={4} placeholder="e.g. 5gb 0200000102" />
            <p className="text-[11px] text-muted-foreground">{text.length} / 500</p>
          </div>
          <Button onClick={() => void run()} disabled={!canRun}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Run
          </Button>
          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6 text-sm">
          {!result && <p className="text-muted-foreground">The result appears here.</p>}
          {result && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Read by</dt>
                <dd>{result.readBy === "ai" ? "AI" : result.readBy === "rules" ? "Rules" : "-"}</dd>
                <dt className="text-muted-foreground">Outcome</dt>
                <dd>{outcomeLabel(result.outcome)}</dd>
                {result.shop !== undefined && (
                  <>
                    <dt className="text-muted-foreground">Shop used</dt>
                    <dd>{result.shop ? `${result.shop.name} (${VIA_LABEL[result.shop.via]}${result.shop.status === "active" ? "" : `, ${result.shop.status}`})` : "None resolved"}</dd>
                    <dt className="text-muted-foreground">Credits reserved</dt>
                    <dd>{result.creditsToReserve ? `${result.creditsToReserve} (nothing is reserved in a try-it)` : "None"}</dd>
                  </>
                )}
              </dl>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Reply the customer would get</div>
                {result.reply ? (
                  <>
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-muted px-3 py-2" data-testid="ttb-reply">{result.reply}</div>
                    {seg && (
                      <p className={`mt-1 text-[11px] ${seg.over ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                        {seg.text}{seg.over ? " (over one SMS)" : ""}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-muted-foreground">No reply would be sent.</p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
