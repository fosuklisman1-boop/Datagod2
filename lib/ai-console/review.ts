// Pure helpers for the console's Conversations and Flags tabs.
import { z } from "zod"

export const PAGE_SIZE = 25
export const PREVIEW_MAX = 120

export interface ListQuery {
  context?: "home" | "storefront" | "dashboard"
  flagged?: boolean
  reviewed?: boolean
  from?: string
  to?: string
  page: number
}

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  })
const boolStr = z.enum(["true", "false"]).transform((v) => v === "true")

const querySchema = z.object({
  context: z.enum(["home", "storefront", "dashboard"]).optional(),
  flagged: boolStr.optional(),
  reviewed: boolStr.optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  page: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).optional(),
})

export function parseListQuery(sp: URLSearchParams): { ok: true; value: ListQuery } | { ok: false } {
  const raw: Record<string, string> = {}
  for (const k of ["context", "flagged", "reviewed", "from", "to", "page"]) {
    const v = sp.get(k)
    if (v !== null && v !== "") raw[k] = v
  }
  const r = querySchema.safeParse(raw)
  if (!r.success) return { ok: false }
  const { page, ...rest } = r.data
  const value: ListQuery = { page: page ?? 1 }
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (value as unknown as Record<string, unknown>)[k] = v
  return { ok: true, value }
}

const REASON_LABELS: Record<string, string> = {
  handoff: "Asked for a human",
  error: "Error",
  refusal: "Assistant refused",
  card_failed: "Confirm card failed",
}
export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason
}

export function previewText(text: string | null | undefined, max = PREVIEW_MAX): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function audienceLabel(context: string, userId: string | null, shopId: string | null): string {
  if (context === "storefront" || (shopId && !userId)) return "Shop visitor"
  return userId ? "Signed-in user" : "Public visitor"
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : ""
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export function pageRange(page: number, size = PAGE_SIZE): { from: number; to: number } {
  return { from: (page - 1) * size, to: page * size - 1 }
}

export function totalPages(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size))
}

export const REVIEW_CHECKLIST = [
  "Open Flags and review each one.",
  "Read 10 random conversations.",
  "Run the answer tests after any prompt or model change.",
  "Check cache usage once a month.",
]
