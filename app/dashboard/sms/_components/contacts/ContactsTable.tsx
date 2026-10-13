"use client"

import { Loader2, ShieldQuestion } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { contactName, toneBadgeClass, type Contact } from "../../_lib/view"
import type { VerifyCounts } from "./types"

interface Props {
  contacts: Contact[]
  busy: boolean
  verifying: boolean
  verifyCounts: VerifyCounts | null
  onVerify: () => void
  onToggleOptOut: (c: Contact) => void
  onDelete: (c: Contact) => void
}

function VerifyBadge({ c }: { c: Contact }) {
  if (c.verify_status === "verified") return <Badge className={toneBadgeClass("success")}>Verified</Badge>
  if (c.verify_status === "invalid") return <Badge className={toneBadgeClass("danger")}>Not found</Badge>
  if (c.verify_status === "pending") {
    return <Badge className={`gap-1 ${toneBadgeClass("muted")}`}><Loader2 className="h-3 w-3 animate-spin" /> Checking…</Badge>
  }
  return <span className="text-muted-foreground">—</span>
}

function OptBadge({ c }: { c: Contact }) {
  return c.opted_out
    ? <Badge className={toneBadgeClass("danger")}>opted out</Badge>
    : <Badge className={toneBadgeClass("success")}>active</Badge>
}

function Actions({ c, busy, onToggleOptOut, onDelete }: Pick<Props, "busy" | "onToggleOptOut" | "onDelete"> & { c: Contact }) {
  return (
    <>
      <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onToggleOptOut(c)} disabled={busy}>
        {c.opted_out ? "Re-include" : "Opt out"}
      </Button>
      <Button variant="ghost" size="sm" className="h-8 text-xs text-destructive hover:text-destructive" onClick={() => onDelete(c)} disabled={busy}>
        Delete
      </Button>
    </>
  )
}

export function ContactsTable({ contacts, busy, verifying, verifyCounts, onVerify, onToggleOptOut, onDelete }: Props) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Contacts ({contacts.length})</CardTitle>
        <Button variant="outline" size="sm" onClick={onVerify} disabled={verifying || contacts.length === 0}>
          {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldQuestion className="h-4 w-4" />} Verify numbers
        </Button>
      </CardHeader>
      <CardContent>
        {verifying && verifyCounts && (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Verifying… {verifyCounts.verified + verifyCounts.invalid}/{verifyCounts.total} checked
          </p>
        )}
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts in this group.</p>
        ) : (
          <>
            {/* Phones: stacked cards */}
            <ul className="space-y-3 md:hidden">
              {contacts.map((c) => (
                <li key={c.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{contactName(c)}</p>
                      {c.verify_status === "verified" && c.verified_name && (
                        <p className="truncate text-xs text-muted-foreground">{c.verified_name}</p>
                      )}
                      <p className="font-mono text-sm text-muted-foreground">{c.phone_number}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1"><OptBadge c={c} /><VerifyBadge c={c} /></div>
                  </div>
                  <div className="mt-2 flex justify-end gap-1">
                    <Actions c={c} busy={busy} onToggleOptOut={onToggleOptOut} onDelete={onDelete} />
                  </div>
                </li>
              ))}
            </ul>

            {/* md+: table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 font-medium">Name</th>
                    <th className="py-2 font-medium">Phone</th>
                    <th className="py-2 font-medium">Verify</th>
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-2">
                        <span>{contactName(c)}</span>
                        {c.verify_status === "verified" && c.verified_name && (
                          <span className="block text-xs text-muted-foreground">{c.verified_name}</span>
                        )}
                      </td>
                      <td className="py-2 font-mono">{c.phone_number}</td>
                      <td className="py-2"><VerifyBadge c={c} /></td>
                      <td className="py-2"><OptBadge c={c} /></td>
                      <td className="py-2 text-right">
                        <Actions c={c} busy={busy} onToggleOptOut={onToggleOptOut} onDelete={onDelete} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
