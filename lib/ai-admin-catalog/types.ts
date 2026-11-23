import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"

export type Risk = "normal" | "money" | "danger"

export interface SecretField {
  name: string
  label: string
  min: number
  max: number
}

export interface CardLine {
  label: string
  value: string
}

export interface CardCtx {
  db: SupabaseClient
  adminId: string
}

export interface EntryInput {
  params?: Record<string, string>
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

export interface ResolvedRequest {
  method: (typeof HTTP_METHODS)[number]
  path: string
  query: string
  body: Record<string, unknown> | null
}

/** A request path must stay under /api/admin/ with no traversal, empty segments, query, fragment or backslash. */
export function isSafeAdminPath(path: string): boolean {
  if (!path.startsWith("/api/admin/")) return false
  if (/[?#\\]/.test(path)) return false
  if (path.includes("//")) return false
  return !path.split("/").some((seg) => seg === ".." || seg === ".")
}

export const ResolvedRequestSchema = z
  .object({
    method: z.enum(HTTP_METHODS),
    path: z.string().min(1).refine(isSafeAdminPath, "path must stay under /api/admin/"),
    query: z.string(),
    body: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()

export interface CatalogEntry {
  id: string
  area: string
  page: string
  pageTitle: string
  summary: string
  method: ResolvedRequest["method"]
  path: string // ":name" params
  params?: Record<string, "uuid" | "slug">
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query?: z.ZodObject<any> // always .strict()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: z.ZodObject<any> // always .strict()
  kind: "lookup" | "change"
  risk: Risk
  auth: "admin" | "support_admin" | "other"
  secretFields?: SecretField[] // body keys filled only by the secure box
  timeoutMs?: number // <= 60_000
  resultKeep?: string[] // required for lookups; dot paths, "items[].id"
  typedCard?:
    | "prepare_wallet_adjustment"
    | "prepare_withdrawal_action"
    | "prepare_user_suspension"
    | "prepare_role_change"
    | "prepare_bulk_status_update"
  card?: (input: EntryInput, ctx: CardCtx) => Promise<{ summary: string; lines: CardLine[] }>
}
