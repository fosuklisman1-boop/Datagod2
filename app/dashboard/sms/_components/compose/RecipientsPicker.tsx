import { useRef, useState } from "react"
import { Plus, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { MAX_RECIPIENTS, parseRows } from "../../_lib/view"
import type { ComposeCustomer, ComposeGroup } from "./types"

interface Props {
  recipients: string[]
  onAdd: (raw: string) => void
  onRemove: (n: string) => void
  customers: ComposeCustomer[]
  groups: ComposeGroup[]
  groupsLoaded: boolean
  selectedGroupId: string
  onGroupChange: (id: string) => void
}

export function RecipientsPicker({ recipients, onAdd, onRemove, customers, groups, groupsLoaded, selectedGroupId, onGroupChange }: Props) {
  const [single, setSingle] = useState("")
  const [list, setList] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)
  const group = groups.find((g) => g.id === selectedGroupId) ?? null

  function addSingle() { onAdd(single); setSingle("") }
  function addList() { onAdd(list); setList("") }

  async function onCsv(file: File | undefined) {
    if (!file) return
    const text = await file.text()
    onAdd(parseRows(text).map((r) => r.phone_number).join(","))
    if (fileRef.current) fileRef.current.value = ""
  }

  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground">
        Recipients ({recipients.length} / max {MAX_RECIPIENTS}){group ? ` + group “${group.name}”` : ""}
      </Label>

      <Tabs defaultValue="paste">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="paste">Paste</TabsTrigger>
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="mine">My customers</TabsTrigger>
          <TabsTrigger value="csv">CSV</TabsTrigger>
        </TabsList>

        <TabsContent value="paste" className="space-y-2 pt-2">
          <div className="flex gap-2">
            <Input
              value={single}
              onChange={(e) => setSingle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSingle() } }}
              placeholder="Add any number, e.g. 0244123456"
              className="font-mono"
            />
            <Button type="button" variant="outline" onClick={addSingle}><Plus className="h-4 w-4" /> Add</Button>
          </div>
          <p className="text-xs text-muted-foreground">Separate several numbers with commas, spaces or new lines.</p>
        </TabsContent>

        <TabsContent value="groups" className="space-y-1.5 pt-2">
          <Select value={selectedGroupId || "none"} onValueChange={(v) => onGroupChange(v === "none" ? "" : v)}>
            <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>{g.name} ({g.contact_count})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {group && (
            <p className="text-xs text-muted-foreground">
              Will send to all active contacts in “{group.name}” (up to {group.contact_count}). Opted-out numbers are skipped.
            </p>
          )}
          {groups.length === 0 && groupsLoaded && (
            <p className="text-xs text-muted-foreground">
              No groups yet — build one in <span className="font-medium">Contacts</span>.
            </p>
          )}
        </TabsContent>

        <TabsContent value="mine" className="space-y-2 pt-2">
          {customers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved customers.</p>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => onAdd(customers.map((c) => c.phone).join(","))}>
                Select all ({customers.length})
              </Button>
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
                {customers.map((c) => (
                  <button key={c.phone} type="button" onClick={() => onAdd(c.phone)}
                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-50"
                    disabled={recipients.includes(c.phone)}>
                    <span>{c.name || "Customer"}</span>
                    <span className="font-mono text-muted-foreground">{c.phone}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="csv" className="space-y-2 pt-2">
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => void onCsv(e.target.files?.[0])} />
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> Upload CSV
          </Button>
          <p className="text-xs text-muted-foreground">
            One number per line (first column; a header row is skipped). For a reusable list, save it as a group in Contacts.
          </p>
          <Textarea value={list} onChange={(e) => setList(e.target.value)} rows={3} placeholder="Or paste a list of numbers…" className="font-mono" />
          <Button type="button" variant="outline" size="sm" onClick={addList} disabled={!list.trim()}>Add numbers</Button>
        </TabsContent>
      </Tabs>

      {recipients.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {recipients.map((n) => (
            <span key={n} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-mono text-xs">
              {n}
              <button type="button" onClick={() => onRemove(n)} aria-label={`Remove ${n}`} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
