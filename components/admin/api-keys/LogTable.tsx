import { format } from "date-fns"
import { cn } from "@/lib/utils"

export interface LogRow {
  id: string
  method: string
  endpoint: string
  status: number
  ms: number | null
  ip: string | null
  time: string
  keyPrefix: string | null
  email: string | null
}

function statusCls(s: number): string {
  if (s >= 200 && s < 400) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (s === 429) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  if (s >= 500) return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"
  return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
}

const when = (t: string) => {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? "—" : format(d, "MMM d, HH:mm:ss")
}

function Status({ s }: { s: number }) {
  return <span className={cn("rounded-md border px-1.5 py-0.5 font-mono text-xs font-bold", statusCls(s))}>{s}</span>
}

function Method({ m }: { m: string }) {
  return <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide text-foreground/80">{m}</span>
}

/** Cards on mobile, a table from lg; no payload columns anywhere. */
export function LogTable({ rows }: { rows: LogRow[] }) {
  return (
    <>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card lg:hidden">
        {rows.map((r) => (
          <li key={r.id} className="space-y-1.5 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Method m={r.method} />
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={r.endpoint}>
                {r.endpoint}
              </span>
              <Status s={r.status} />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{when(r.time)}</span>
              <span className="tabular-nums">{r.ms === null ? "—" : `${r.ms} ms`}</span>
              {r.ip && <span className="font-mono">{r.ip}</span>}
            </div>
            {(r.keyPrefix || r.email) && (
              <p className="truncate text-xs text-muted-foreground">
                {r.keyPrefix && <span className="font-mono">{r.keyPrefix}…</span>}
                {r.keyPrefix && r.email && " · "}
                {r.email}
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-2xl border border-border bg-card lg:block">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/60 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground dark:bg-white/[0.03]">
              <th className="w-[150px] px-4 py-3">Time</th>
              <th className="px-4 py-3">Endpoint</th>
              <th className="w-[220px] px-4 py-3">Key / owner</th>
              <th className="w-[80px] px-4 py-3">Status</th>
              <th className="w-[80px] px-4 py-3 text-right">ms</th>
              <th className="w-[140px] px-4 py-3">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/40">
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{when(r.time)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Method m={r.method} />
                    <span className="truncate font-mono text-foreground" title={r.endpoint}>
                      {r.endpoint}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <p className="truncate font-mono text-xs text-foreground/80">{r.keyPrefix ? `${r.keyPrefix}…` : "—"}</p>
                  <p className="truncate text-xs text-muted-foreground" title={r.email ?? undefined}>{r.email ?? ""}</p>
                </td>
                <td className="px-4 py-2.5">
                  <Status s={r.status} />
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.ms === null ? "—" : r.ms}</td>
                <td className="truncate px-4 py-2.5 font-mono text-xs text-muted-foreground">{r.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
