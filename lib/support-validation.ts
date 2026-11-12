import { z } from "zod"

export const GH_PHONE_RE = /^(0|\+233)[2-9][0-9]{8}$/

export const SUPPORT_CATEGORIES = ["order", "payment", "account", "other"] as const

const SCRIPT_PATTERNS = [/javascript:/i, /<script/i, /on\w+\s*=/i]
const hasScript = (s: string) => SCRIPT_PATTERNS.some((re) => re.test(s))
const hasMarkup = (s: string) => /[<>&]/.test(s)

/** Customer text: trimmed, no <, > or &, no script-injection patterns. */
function customerText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !hasMarkup(s) && !hasScript(s), { message: "Text contains characters that are not allowed" })
}

/** Admin text: trimmed; <, > and & allowed, script-injection patterns still rejected. */
function adminText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !hasScript(s), { message: "Text contains characters that are not allowed" })
}

const phone = z.string().trim().regex(GH_PHONE_RE, "Enter a valid Ghana phone number")

export const createThreadSchema = z
  .object({
    subject: customerText(3, 200),
    category: z.enum(SUPPORT_CATEGORIES),
    message: customerText(5, 5000),
    phone_number: phone,
    whatsapp_number: phone,
    order_id: z.string().uuid().optional(),
    shop_order_id: z.string().uuid().optional(),
  })
  .refine((v) => !(v.order_id && v.shop_order_id), {
    message: "Link either an order or a shop order, not both",
    path: ["shop_order_id"],
  })

export const userMessageSchema = z.object({ message: customerText(1, 5000) })

export const adminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), message: adminText(1, 5000) }),
  z.object({ action: z.literal("close"), note: adminText(0, 2000).optional() }),
  z.object({ action: z.literal("read") }),
])

export const resolveComplaintSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["resolved", "rejected"]),
  resolution_notes: z.string().trim().max(2000),
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}
