"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, RefreshCw } from "lucide-react"
import { supabase } from "@/lib/supabase"

type Row = { landing: string; count: number }
type Data = { total: number; truncated: boolean; rows: Row[] }

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

/** Sign-ups of the last 30 days per first landing page. All values render as plain (escaped) text. */
export default function SignupSourcesCard() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/signup-sources", { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error("load failed")
      const json = await res.json()
      setData({
        total: Number(json.total) || 0,
        truncated: json.truncated === true,
        rows: Array.isArray(json.rows) ? json.rows : [],
      })
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Card className="mb-6 border-border">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Sign-ups by landing page</CardTitle>
          <CardDescription>
            The first page each new user landed on, last 30 days. &quot;unknown&quot; = signed up before tracking started,
            blocked storage, or arrived straight on a sign-in page.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0" aria-label="Refresh">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </Button>
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : failed ? (
          <p className="text-sm text-destructive">Could not load sign-up sources.</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sign-ups in the last 30 days.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {data.total.toLocaleString()} sign-ups{data.truncated ? " (first 5,000 counted)" : ""}
            </p>
            <div className="overflow-hidden rounded-md border border-border lg:max-w-3xl">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Landing page</th>
                    <th className="w-20 px-3 py-2 text-right font-medium lg:w-28">Sign-ups</th>
                    <th className="hidden w-24 px-3 py-2 text-right font-medium lg:table-cell">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={String(r.landing)} className="border-t border-border">
                      <td className="truncate px-3 py-2 font-mono text-xs" title={String(r.landing)}>
                        {String(r.landing)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.count) || 0}</td>
                      <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground lg:table-cell">
                        {data.total ? `${Math.round(((Number(r.count) || 0) / data.total) * 100)}%` : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
