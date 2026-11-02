"use client"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { X } from "lucide-react"
import type { UsersListFilters } from "@/lib/admin-users/list-params"

const boolToValue = (b: boolean | null) => (b == null ? "all" : b ? "true" : "false")
const valueToBool = (v: string) => (v === "all" ? null : v === "true")

export function hasActiveFilters(f: UsersListFilters): boolean {
  return !!(f.q || f.role || f.suspended != null || f.hasShop != null || f.pricingMode || f.from || f.to)
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
