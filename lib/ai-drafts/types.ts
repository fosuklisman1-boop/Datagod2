import { z } from "zod"

export const DRAFT_ACTIONS = [
  "wallet_order",
  "wallet_adjustment",
  "withdrawal_action",
  "user_suspension",
  "role_change",
  "bulk_status_update",
] as const
export type DraftAction = (typeof DRAFT_ACTIONS)[number]

export const DRAFT_STATUSES = [
  "pending",
  "executing",
  "succeeded",
  "partial",
  "failed",
  "unknown",
  "expired",
  "superseded",
  "cancelled",
] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

/** Statuses that carry an execution outcome (the card shows a result). */
export const OUTCOME_STATUSES = ["succeeded", "partial", "failed", "unknown"] as const

export type DraftContext = "dashboard" | "admin"

export const EXPIRY_MS = {
  dashboard: 600_000, // 10 min
  admin: 300_000, // 5 min
  adminBackground: 43_200_000, // 12 h, drafts created by background tasks
} as const

export const CAPS = {
  walletOrderGhs: 500,
  walletAdjustmentGhs: 2000,
  withdrawalTotalGhs: 10000,
  bulkStatusIds: 500,
} as const

const money = z.number().finite().positive()
const balance = z.number().finite()
const id = z.string().uuid()

export const WalletOrderParams = z
  .object({
    packageId: id,
    network: z.string().min(1),
    size: z.string().min(1),
    recipient: z.string().min(1),
    price: money,
    balanceBefore: balance,
    schedule: z
      .object({
        type: z.enum(["once", "daily", "weekly"]),
        runAtTime: z.string().min(1).optional(),
        runOnDays: z.array(z.number().int().min(0).max(6)).optional(),
        runAtTimestamp: z.string().min(1).optional(),
      })
      .strict()
      .superRefine((s, ctx) => {
        const bad = (message: string) => ctx.addIssue({ code: "custom", message })
        if (s.type === "once") {
          if (!s.runAtTimestamp || !Number.isFinite(Date.parse(s.runAtTimestamp))) bad("once schedule needs a valid runAtTimestamp")
          return
        }
        if (!s.runAtTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.runAtTime)) bad("runAtTime must be HH:MM (24h)")
        if (s.type === "weekly" && (!s.runOnDays || s.runOnDays.length === 0 || new Set(s.runOnDays).size !== s.runOnDays.length)) {
          bad("weekly schedule needs unique runOnDays")
        }
      })
      .optional(),
  })
  .strict()

export const WalletAdjustmentParams = z
  .object({
    targetUserId: id,
    type: z.enum(["credit", "debit"]),
    amount: money,
    reason: z.string().min(1),
    balanceBefore: balance,
  })
  .strict()

export const WithdrawalActionParams = z
  .object({
    action: z.enum(["approve", "reject", "complete"]),
    ids: z.array(id).min(1),
    totalGhs: money,
    reason: z.string().optional(),
  })
  .strict()

export const UserSuspensionParams = z
  .object({
    targetUserId: id,
    suspend: z.boolean(),
  })
  .strict()

export const RoleChangeParams = z
  .object({
    targetUserId: id,
    fromRole: z.string().min(1),
    toRole: z.string().min(1),
  })
  .strict()

const idList = z.array(id)

export const BulkStatusParams = z
  .object({
    status: z.string().min(1),
    idsByTable: z
      .object({
        orders: idList,
        shop_orders: idList,
        ussd_orders: idList,
        ussd_shop_orders: idList,
        api_orders: idList,
      })
      .strict(),
    filter: z.record(z.string(), z.unknown()),
  })
  .strict()

const SCHEMAS = {
  wallet_order: WalletOrderParams,
  wallet_adjustment: WalletAdjustmentParams,
  withdrawal_action: WithdrawalActionParams,
  user_suspension: UserSuspensionParams,
  role_change: RoleChangeParams,
  bulk_status_update: BulkStatusParams,
} as const

export function paramsSchemaFor(action: DraftAction) {
  const schema = SCHEMAS[action]
  if (!schema) throw new Error(`Unknown draft action: ${String(action)}`)
  return schema
}

export interface AiDraft {
  id: string
  user_id: string
  context: DraftContext
  action: DraftAction
  params: Record<string, unknown>
  display: Record<string, unknown>
  amount_ghs: number | null
  status: DraftStatus
  outcome: Record<string, unknown> | null
  expires_at: string
  conversation_key: string | null
  created_at: string
  updated_at: string
  executed_at: string | null
}

export type DraftToolResult =
  | { draft_id: string; display: Record<string, unknown>; expires_at: string; warnings: string[] }
  | { refused: true; code: string; message: string }
