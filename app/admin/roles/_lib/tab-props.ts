import type { HubRole } from "./ladder-view"

/** Props shared by the editing tabs (Prices, Services, Rights, Members). */
export interface EditTabProps {
  role: HubRole
  /** Every role, for the "copy from" and move-target lists. */
  roles: HubRole[]
  /** Shared in-flight flag so no two writes overlap. */
  busy: boolean
  setBusy: (b: boolean) => void
  /** Called with the failure so the page can reload on a 409. */
  onError: (e: unknown) => Promise<void> | void
  /** Tells the page whether this tab has unsaved edits (tab-switch and beforeunload guards). */
  onDirtyChange: (dirty: boolean) => void
  /** Reload the role list (member counts) after a write that changes it. */
  onChanged?: () => Promise<void> | void
}

/** Roles whose prices or rights can be copied from: live, never admin or sub_agent, never the role being edited. */
export function copySources(roles: readonly HubRole[], currentId: string): { id: string; name: string }[] {
  return roles
    .filter((r) => !r.archived_at && r.id !== currentId && r.slug !== "admin" && r.slug !== "sub_agent")
    .map((r) => ({ id: r.id, name: r.name }))
}
