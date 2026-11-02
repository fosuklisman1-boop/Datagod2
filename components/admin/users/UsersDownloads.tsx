"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import type { UsersListFilters } from "@/lib/admin-users/list-params"
import { allDataCsv, emailsCsv, exportLabel, phonesCsv } from "@/lib/admin-users/csv"

type Kind = "emails" | "phones" | "all"

const downloadAsCSV = (filename: string, data: string) => {
  const element = document.createElement("a")
  element.setAttribute("href", "data:text/csv;charset=utf-8," + encodeURIComponent(data))
  element.setAttribute("download", filename)
  element.style.display = "none"
  document.body.appendChild(element)
  element.click()
  document.body.removeChild(element)
}

const KINDS: Record<Kind, { button: string; noun: string; file: string; build: (u: Parameters<typeof allDataCsv>[0]) => string }> = {
  emails: { button: "Emails", noun: "emails", file: "emails", build: emailsCsv },
  phones: { button: "Phones", noun: "phone numbers", file: "phone_numbers", build: phonesCsv },
  all: { button: "All Data", noun: "users", file: "users", build: (u) => allDataCsv(u) },
}

/**
 * Emails / Phones / All Data CSV downloads of every user matching the current
 * filters and search (not just the visible page), fetched 200 at a time.
 */
export function UsersDownloads({ filters }: { filters: UsersListFilters }) {
  const [busy, setBusy] = useState<Kind | null>(null)
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null)

  const run = async (kind: Kind) => {
    const k = KINDS[kind]
    setBusy(kind)
    setProgress(null)
    try {
      const users = await adminUserService.getAllUsers(filters, (loaded, total) => setProgress({ loaded, total }))
      if (users.length === 0) {
        toast.error("No users match the current filters")
        return
      }
      const date = new Date().toISOString().split("T")[0]
      downloadAsCSV(`${k.file}_${exportLabel(filters)}_${date}.csv`, k.build(users))
      toast.success(`${users.length} ${k.noun} downloaded successfully`)
    } catch (error) {
      console.error(`Error downloading ${k.noun}:`, error)
      toast.error(error instanceof Error ? error.message : `Failed to download ${k.noun}`)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row items-stretch sm:items-center">
      {busy && progress && progress.total > 0 && (
        <span className="text-xs text-muted-foreground whitespace-nowrap" aria-live="polite">
          {progress.loaded.toLocaleString()} / {progress.total.toLocaleString()}
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
