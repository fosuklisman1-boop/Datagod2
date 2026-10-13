"use client"

import { useRef, useState } from "react"
import { Loader2, Plus, Upload, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseRows, type BulkRow } from "../../_lib/view"

interface Props {
  groupName: string
  busy: boolean
  onAddSingle: (first: string, last: string, phone: string) => Promise<boolean>
  onImportRows: (rows: BulkRow[], verifyOnImport: boolean) => Promise<void>
}

export function AddContacts({ groupName, busy, onAddSingle, onImportRows }: Props) {
  const [first, setFirst] = useState("")
  const [last, setLast] = useState("")
  const [phone, setPhone] = useState("")
  const [bulk, setBulk] = useState("")
  const [verifyOnImport, setVerifyOnImport] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function addSingle() {
    if (await onAddSingle(first, last, phone)) { setFirst(""); setLast(""); setPhone("") }
  }

  async function importBulk() {
    const rows = parseRows(bulk)
    if (rows.length === 0) return toast.error("No valid rows to import.")
    await onImportRows(rows, verifyOnImport)
    setBulk("")
  }

  async function importCsvFile(file: File) {
    try {
      const rows = parseRows(await file.text())
      if (rows.length === 0) { toast.error("CSV had no valid rows."); return }
      await onImportRows(rows, verifyOnImport)
    } catch {
      toast.error("Could not read that file.")
    } finally {
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="h-4 w-4" /> <span className="truncate">Add to {groupName}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Input value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First name" />
          <Input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Last name" />
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (0XXXXXXXXX)" className="col-span-2 font-mono sm:col-span-1" />
          <Button className="col-span-2 sm:col-span-1" onClick={() => void addSingle()} disabled={busy || !phone.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
          </Button>
        </div>

        <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
          <Checkbox id="verifyOnImport" checked={verifyOnImport} onCheckedChange={(v) => setVerifyOnImport(v === true)} className="mt-0.5" />
          <div className="space-y-0.5">
            <Label htmlFor="verifyOnImport" className="text-sm font-medium">Verify numbers (fetch MoMo name)</Label>
            <p className="text-xs text-muted-foreground">Verifying looks up each number&apos;s registered Mobile Money name (slow — runs in the background).</p>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border p-3">
          <Label className="flex items-center gap-2 text-sm font-medium"><Upload className="h-4 w-4" /> Upload CSV</Label>
          <p className="text-xs text-muted-foreground">
            Columns: <code>phone,firstName,lastName</code> (name fields optional; a header row is tolerated).
          </p>
          <Input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsvFile(f) }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bulk" className="text-sm font-medium">…or paste rows</Label>
          <Textarea
            id="bulk"
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            rows={4}
            placeholder={"0241234567,Ama,Mensah\n0207654321"}
            className="font-mono text-sm"
          />
          <Button variant="outline" onClick={() => void importBulk()} disabled={busy || !bulk.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import pasted rows
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
