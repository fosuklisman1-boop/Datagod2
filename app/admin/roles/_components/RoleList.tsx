"use client"

import Link from "next/link"
import { ArrowDown, ArrowUp, Copy, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FIXED_SLUGS, ladderState, type HubRole } from "../_lib/ladder-view"
import { RoleBadge } from "./RoleBadge"

interface Props {
  roles: HubRole[]
  /** True while any write is in flight: every action button is disabled. */
  busy: boolean
  onMove: (role: HubRole, direction: "up" | "down") => void
  onClone: (role: HubRole) => void
}

export function RoleList({ roles, busy, onMove, onClone }: Props) {
  const { ladder, offLadder, archived, movable } = ladderState(roles)

  const renderRow = (role: HubRole, opts: { ladder: boolean; archived?: boolean }) => {
    const isAdmin = role.slug === "admin"
    const mi = movable.indexOf(role.slug)
    const canMove = opts.ladder && !opts.archived && !FIXED_SLUGS.has(role.slug)
    return (
      <li
        key={role.id}
        data-role-row={role.slug}
        className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <RoleBadge name={role.name} color={role.badge_color} icon={role.icon} />
            <span className="text-xs text-muted-foreground">{role.slug}</span>
            {role.rank != null ? <span className="text-xs text-muted-foreground">rank {role.rank}</span> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {role.member_count} member{role.member_count === 1 ? "" : "s"}
            {isAdmin ? " · read-only" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {canMove ? (
            <>
              <Button
                data-move="up"
                type="button"
                variant="outline"
                size="icon"
                aria-label={`Move ${role.name} up`}
                disabled={busy || mi <= 0}
                onClick={() => onMove(role, "up")}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                data-move="down"
                type="button"
                variant="outline"
                size="icon"
                aria-label={`Move ${role.name} down`}
                disabled={busy || mi === movable.length - 1}
                onClick={() => onMove(role, "down")}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {!isAdmin && !opts.archived ? (
            <Button
              data-clone={role.slug}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onClone(role)}
            >
              <Copy className="mr-1 h-4 w-4" /> Clone
            </Button>
          ) : null}
          {!isAdmin ? (
            <Button asChild size="sm">
              <Link href={`/admin/roles/${role.id}`}>
                <Pencil className="mr-1 h-4 w-4" /> {opts.archived ? "View" : "Edit"}
              </Link>
            </Button>
          ) : null}
        </div>
      </li>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rank ladder</CardTitle>
          <p className="text-xs text-muted-foreground">Most senior at the top. A role falls back to the prices of the roles below it.</p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">{ladder.map((r) => renderRow(r, { ladder: true }))}</ul>
        </CardContent>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Off the ladder</CardTitle>
          </CardHeader>
          <CardContent>
            {offLadder.length ? (
              <ul className="space-y-2">{offLadder.map((r) => renderRow(r, { ladder: false }))}</ul>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Archived</CardTitle>
          </CardHeader>
          <CardContent>
            {archived.length ? (
              <ul className="space-y-2">{archived.map((r) => renderRow(r, { ladder: false, archived: true }))}</ul>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
