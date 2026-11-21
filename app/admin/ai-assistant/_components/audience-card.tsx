"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MIN_TOOL_STEPS, MAX_TOOL_STEPS, type Audiences, type AudienceKey } from "@/lib/ai-console/settings"

const ROWS: { key: AudienceKey; title: string; body: string }[] = [
  { key: "admins", title: "Admins", body: "The assistant inside the admin area." },
  { key: "signedIn", title: "Signed-in users", body: "Customers and agents using their dashboard." },
  { key: "shopVisitors", title: "Shop visitors", body: "People browsing a shop storefront." },
  { key: "publicVisitors", title: "Public visitors", body: "Anyone on the public site who is not signed in." },
]

export function AudienceCard({
  audiences, onChange, maxSteps, onMaxSteps, stepsError,
}: {
  audiences: Audiences
  onChange: (a: Audiences) => void
  maxSteps: string
  onMaxSteps: (v: string) => void
  stepsError: string | null
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Who can use it</CardTitle>
        <p className="text-xs text-muted-foreground">
          Four independent switches. Turning one off hides the chat for that group only.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y divide-border rounded-xl border border-border">
          {ROWS.map((r) => (
            <li key={r.key} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{r.title}</p>
                <p className="text-xs text-muted-foreground">{r.body}</p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${audiences[r.key] ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                {audiences[r.key] ? "On" : "Off"}
              </span>
              <Switch
                aria-label={r.title}
                checked={audiences[r.key]}
                onCheckedChange={(v) => onChange({ ...audiences, [r.key]: v })}
              />
            </li>
          ))}
        </ul>
        <div className="space-y-1">
          <Label htmlFor="max-steps" className="text-sm font-medium">Max tool steps per answer</Label>
          <Input
            id="max-steps"
            type="number"
            inputMode="numeric"
            min={MIN_TOOL_STEPS}
            max={MAX_TOOL_STEPS}
            value={maxSteps}
            onChange={(e) => onMaxSteps(e.target.value)}
            placeholder="Default (10, admin 20)"
            className="max-w-[12rem]"
          />
          <p className={`text-xs ${stepsError ? "text-destructive" : "text-muted-foreground"}`}>
            {stepsError ?? `How many look-ups the assistant may make before answering, ${MIN_TOOL_STEPS} to ${MAX_TOOL_STEPS}. Leave empty for the default.`}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
