"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import type { UsersListFilters } from "@/lib/admin-users/list-params"
import { allDataCsv, emailsCsv, exportLabel, phonesCsv, triggerCsvDownload } from "@/lib/admin-users/csv"
import { UsersExportError } from "@/lib/admin-users/export-client"

type Kind = "emails" | "phones" | "all"

const KINDS: Record<Kind, { button: string; noun: string; file: string; build: (u: Parameters<typeof allDataCsv>[0]) => string }> = {
  emails: { button: "Emails", noun: "emails", file: "emails", build: emailsCsv },
  phones: { button: "Phones", noun: "phone numbers", file: "phone_numbers", build: phonesCsv },
  all: { button: "All Data", noun: "users", file: "users", build: (u) => allDataCsv(u) },
}

/**
 * Emails / Phones / All Data CSV downloads of every user matching the current
 * filters and search (not just the visible page), oldest signup first, fetched
 * 5000 at a time from the export endpoint. If the export can't finish, nothing
 * is downloaded and the error says how far it got.
 */
export function UsersDownloads({ filters }: { filters: UsersListFilters }) {
  const [busy, setBusy] = useState<Kind | null>(null)
  const [loaded, setLoaded] = useState<number | null>(null)

  const run = async (kind: Kind) => {
    const k = KINDS[kind]
    setBusy(kind)
    setLoaded(null)
    try {
      const users = await adminUserService.getAllUsers(filters, setLoaded)
      if (users.length === 0) {
        toast.error("No users match the current filters")
        return
      }
      const date = new Date().toISOString().split("T")[0]
      triggerCsvDownload(`${k.file}_${exportLabel(filters)}_${date}.csv`, k.build(users))
      toast.success(`${users.length} ${k.noun} downloaded successfully`)
    } catch (error) {
      console.error(`Error downloading ${k.noun}:`, error)
      if (error instanceof UsersExportError) {
        toast.error(`${error.message}. Nothing was downloaded; please try again.`, { duration: 10000 })
      } else {
        toast.error(error instanceof Error ? error.message : `Failed to download ${k.noun}`)
      }
    } finally {
      setBusy(null)
      setLoaded(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row items-stretch sm:items-center">
      {busy && loaded != null && (
        <span className="text-xs text-muted-foreground whitespace-nowrap" aria-live="polite">
          {loaded.toLocaleString()} users…
        </span>
      )}
      {(Object.keys(KINDS) as Kind[]).map((kind) => (
        <Button
          key={kind}
          onClick={() => run(kind)}
          disabled={busy !== null}
          variant="outline"
          className="text-sm gap-2 w-full sm:w-auto"
          title={`Download ${KINDS[kind].noun} for every user matching the current filters`}
        >
          {busy === kind ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {KINDS[kind].button}
        </Button>
      ))}
    </div>
  )
}
