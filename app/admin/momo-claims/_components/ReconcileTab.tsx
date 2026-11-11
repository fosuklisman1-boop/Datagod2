"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { adminErrorMessage, csvHeaderColumns, inclusiveSpanDays } from "@/lib/momo-claim/admin-view"
import { adminFetch, ApiError } from "./api"

const API = "/api/admin/momo-claims/reconcile"
const MAX_DAYS = 62

type Result = { statementTxids: number; claimedChecked: number; missing: string[]; saved: boolean }
type Run = {
  id: string
  period_start: string
  period_end: string
  statement_txids: number
  claimed_checked: number
  missing_txids: string[]
  missingCount: number
  created_at: string
}

export function ReconcileTab() {
  const [csv, setCsv] = useState("")
  const [fileName, setFileName] = useState("")
  const [column, setColumn] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [runs, setRuns] = useState<Run[]>([])

  const columns = csvHeaderColumns(csv)
  const span = inclusiveSpanDays(start, end)
  const periodOk = span !== null && span >= 1 && span <= MAX_DAYS
  const canRun = !!csv && !!column && periodOk && !busy

  const loadRuns = useCallback(async () => {
    try {
      const r = await adminFetch<{ runs: Run[] }>(API)
      setRuns(r.runs)
    } catch {
      /* the list is secondary; the form still works */
    }
  }, [])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  async function onFile(f: File | undefined) {
    setResult(null)
    setError(null)
    if (!f) return
    const text = await f.text()
    setCsv(text)
    setFileName(f.name)
    const cols = csvHeaderColumns(text)
    setColumn(cols.find((c) => /trans.*id|txn|reference/i.test(c)) ?? "")
  }

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await adminFetch<{ statementTxids: number; claimedChecked: number; missing: string[] }>(API, {
        method: "POST",
        body: { csv, column, periodStart: start, periodEnd: end },
      })
      setResult({ ...r, saved: true })
      void loadRuns()
    } catch (e) {
      if (e instanceof ApiError && e.code === "run_not_saved" && Array.isArray(e.body.missing)) {
        setResult({ statementTxids: 0, claimedChecked: 0, missing: e.body.missing as string[], saved: false })
      } else {
        setError(adminErrorMessage(e instanceof ApiError ? e.code : undefined))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Check against the MTN statement</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">Every wallet credit from a forwarded SMS in the period must appear in your statement. A missing ID means a forged SMS was credited.</p>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="rc-file">Statement CSV</label>
            <Input id="rc-file" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} />
            {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
          </div>
          {columns.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="rc-col">Transaction ID column</label>
              <select id="rc-col" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={column} onChange={(e) => setColumn(e.target.value)}>
                <option value="">Choose a column</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="rc-start">Start date</label>
              <Input id="rc-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="rc-end">End date</label>
              <Input id="rc-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          {start && end && !periodOk && (
            <p className="text-xs text-red-600 dark:text-red-400">{span === null || span < 1 ? "Start must not be after end." : `The period can be at most ${MAX_DAYS} days (this is ${span}).`}</p>
          )}
          <Button onClick={() => void run()} disabled={!canRun}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Run check
          </Button>
          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {result && (
          <Card>
            <CardHeader><CardTitle className="text-base">Result</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!result.saved && (
                <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
                  {adminErrorMessage("run_not_saved")}
                </p>
              )}
              {result.saved && (
                <p>Statement IDs: <b>{result.statementTxids}</b> · Claimed in period: <b>{result.claimedChecked}</b></p>
              )}
              {result.missing.length === 0 ? (
                <p className="text-emerald-700 dark:text-emerald-400">Nothing missing: every claimed ID is in the statement.</p>
              ) : (
                <div>
                  <p className="font-medium text-red-600 dark:text-red-400">{result.missing.length} claimed ID(s) NOT in the statement</p>
                  <ul className="mt-1 max-h-48 overflow-auto font-mono text-xs text-red-600 dark:text-red-400">
                    {result.missing.map((m) => <li key={m}>{m}</li>)}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Statement</TableHead>
                  <TableHead className="text-right">Claimed</TableHead>
                  <TableHead className="text-right">Missing</TableHead>
                  <TableHead>Run at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 && <TableRow><TableCell colSpan={5} className="py-4 text-center text-muted-foreground">No runs yet.</TableCell></TableRow>}
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">{r.period_start} to {r.period_end}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.statement_txids}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.claimed_checked}</TableCell>
                    <TableCell className={`text-right tabular-nums ${r.missingCount > 0 ? "font-semibold text-red-600 dark:text-red-400" : ""}`} title={r.missing_txids.join(", ")}>{r.missingCount}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
