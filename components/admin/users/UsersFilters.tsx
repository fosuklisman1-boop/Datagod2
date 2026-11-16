"use client"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { X } from "lucide-react"
import { useEffect, useState } from "react"
import type { UsersListFilters } from "@/lib/admin-users/list-params"
import { SUGGESTED_TAGS, normaliseTag } from "@/lib/admin-users/notes-tags"
import { useDebouncedValue } from "@/hooks/use-debounced-value"

const boolToValue = (b: boolean | null) => (b == null ? "all" : b ? "true" : "false")
const valueToBool = (v: string) => (v === "all" ? null : v === "true")

export function hasActiveFilters(f: UsersListFilters): boolean {
  return !!(f.q || f.role || f.suspended != null || f.hasShop != null || f.pricingMode || f.from || f.to || f.tag)
}

interface UsersFiltersProps {
  filters: UsersListFilters
  /** What is in the search box right now (applied to the URL after a 300ms pause). */
  searchInput: string
  onSearchInput: (value: string) => void
  onChange: (patch: Partial<UsersListFilters>) => void
  onReset: () => void
}

export function UsersFilters({ filters, searchInput, onSearchInput, onChange, onReset }: UsersFiltersProps) {
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Input
          placeholder="Search by email, phone or shop..."
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          aria-label="Search users"
          className="border-border focus:border-success/30 text-sm px-2 py-2 sm:w-64"
        />
        <Select value={filters.role ?? "all"} onValueChange={(v) => onChange({ role: v === "all" ? null : (v as UsersListFilters["role"]) })}>
          <SelectTrigger className="w-full sm:w-[140px] text-sm" aria-label="Role filter">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="user">Users</SelectItem>
            <SelectItem value="dealer">Dealers</SelectItem>
            <SelectItem value="sub_agent">Sub Agents</SelectItem>
            <SelectItem value="admin">Admins</SelectItem>
          </SelectContent>
        </Select>
        <Select value={boolToValue(filters.suspended)} onValueChange={(v) => onChange({ suspended: valueToBool(v) })}>
          <SelectTrigger className="w-full sm:w-[150px] text-sm" aria-label="Suspended filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Status: All</SelectItem>
            <SelectItem value="false">Active</SelectItem>
            <SelectItem value="true">Suspended</SelectItem>
          </SelectContent>
        </Select>
        <Select value={boolToValue(filters.hasShop)} onValueChange={(v) => onChange({ hasShop: valueToBool(v) })}>
          <SelectTrigger className="w-full sm:w-[140px] text-sm" aria-label="Shop filter">
            <SelectValue placeholder="Shop" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Shop: All</SelectItem>
            <SelectItem value="true">Has a shop</SelectItem>
            <SelectItem value="false">No shop</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.pricingMode === "custom" ? "custom" : "all"} onValueChange={(v) => onChange({ pricingMode: v === "custom" ? "custom" : null })}>
          <SelectTrigger className="w-full sm:w-[160px] text-sm" aria-label="Pricing filter">
            <SelectValue placeholder="Pricing" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Pricing: All</SelectItem>
            <SelectItem value="custom">Pricing: Custom pricing</SelectItem>
          </SelectContent>
        </Select>
        <TagFilter value={filters.tag} onChange={(tag) => onChange({ tag })} />
      </div>
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex items-center gap-2">
          <Label htmlFor="users-from" className="text-xs text-muted-foreground whitespace-nowrap">Joined from</Label>
          <Input
            id="users-from"
            type="date"
            value={filters.from ?? ""}
            max={filters.to ?? undefined}
            onChange={(e) => onChange({ from: e.target.value || null })}
            className="text-sm sm:w-[150px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="users-to" className="text-xs text-muted-foreground">to</Label>
          <Input
            id="users-to"
            type="date"
            value={filters.to ?? ""}
            min={filters.from ?? undefined}
            onChange={(e) => onChange({ to: e.target.value || null })}
            className="text-sm sm:w-[150px]"
          />
        </div>
        {(hasActiveFilters(filters) || searchInput.trim()) && (
          <Button variant="ghost" size="sm" onClick={onReset} className="gap-1 text-muted-foreground">
            <X className="w-4 h-4" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}

/** Tag filter: type any tag or pick a suggested one. Applied after a pause once the text is a valid tag (or cleared). */
function TagFilter({ value, onChange }: { value: string | null; onChange: (tag: string | null) => void }) {
  const [text, setText] = useState(value ?? "")
  const debounced = useDebouncedValue(text, 300)
  // URL changed from outside (Clear filters, back/forward): show it.
  useEffect(() => {
    if ((normaliseTag(text) ?? null) !== value) setText(value ?? "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  useEffect(() => {
    const raw = debounced.trim()
    const next = raw ? normaliseTag(raw) : null
    if ((raw === "" || next) && next !== value) onChange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])
  const invalid = text.trim() !== "" && !normaliseTag(text)
  return (
    <>
      <Input
        list="users-tag-suggestions"
        placeholder="Tag (e.g. vip)"
        value={text}
        aria-label="Tag filter"
        aria-invalid={invalid}
        title={invalid ? "Tags are 1 to 32 characters: a-z, 0-9 and -" : undefined}
        onChange={(e) => setText(e.target.value)}
        className={`text-sm sm:w-[150px] ${invalid ? "border-destructive" : ""}`}
      />
      <datalist id="users-tag-suggestions">
        {SUGGESTED_TAGS.map((t) => <option key={t} value={t} />)}
      </datalist>
    </>
  )
}
