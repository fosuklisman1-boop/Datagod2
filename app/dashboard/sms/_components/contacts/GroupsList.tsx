"use client"

import { useState } from "react"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { Group } from "./types"

interface Props {
  groups: Group[]
  loaded: boolean
  selectedId: string | null
  busy: boolean
  onSelect: (g: Group) => void
  onCreate: (name: string, description: string) => Promise<boolean>
  onDelete: (g: Group) => void
}

export function GroupsList({ groups, loaded, selectedId, busy, onSelect, onCreate, onDelete }: Props) {
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")

  async function create() {
    if (await onCreate(name, desc)) { setName(""); setDesc("") }
  }

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle className="text-base">Groups</CardTitle>
        <CardDescription>Address-book groups for targeted SMS.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" maxLength={100} />
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" />
          <Button className="w-full" onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create group
          </Button>
        </div>

        {!loaded ? (
          <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
        ) : (
          <ul className="divide-y">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-2 py-2">
                <button
                  type="button"
                  onClick={() => onSelect(g)}
                  aria-current={selectedId === g.id}
                  className={`min-h-10 min-w-0 flex-1 text-left text-sm ${selectedId === g.id ? "font-semibold text-primary" : ""}`}
                >
                  <span className="block truncate">{g.name}</span>
                  <span className="text-xs text-muted-foreground">{g.contact_count} contact{g.contact_count === 1 ? "" : "s"}</span>
                </button>
                <Button
                  variant="ghost" size="icon" aria-label={`Delete group ${g.name}`}
                  className="h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => onDelete(g)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
            {groups.length === 0 && <li className="py-2 text-sm text-muted-foreground">No groups yet.</li>}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
