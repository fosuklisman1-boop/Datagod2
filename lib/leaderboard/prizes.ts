// Prize rules shared by the admin routes and the admin page. The table CHECKs in
// migrations/0135_leaderboard_rewards.sql enforce the same limits as a backstop.

import { BOARDS, type Board } from "./periods"

export type PrizeType = "wallet_topup" | "data_bundle" | "airtime" | "role_upgrade" | "manual"
export const PRIZE_TYPES: readonly PrizeType[] = ["wallet_topup", "data_bundle", "airtime", "role_upgrade", "manual"]
export const PRIZE_RANKS = [1, 2, 3] as const
export type PrizeRank = (typeof PRIZE_RANKS)[number]

export const PRIZE_TYPE_LABEL: Record<PrizeType, string> = {
  wallet_topup: "Wallet top-up",
  data_bundle: "Data bundle",
  airtime: "Airtime",
  role_upgrade: "Role upgrade",
  manual: "Manual",
}

export const AIRTIME_NETWORKS = ["MTN", "Telecel", "AT"] as const
export const UPGRADE_ROLES = ["dealer"] as const
export const MAX_WALLET_PRIZE = 100000
export const MAX_AIRTIME_PRIZE = 10000
export const MAX_LABEL = 80
export const MAX_PRESET_NAME = 60

/** The fields a prize or preset carries; unused fields are null for the type. */
export interface PrizeFields {
  prize_type: PrizeType
  label: string
  amount: number | null
  package_id: string | null
  network: string | null
  role: string | null
  duration_days: number | null
}

export interface PrizeRow extends PrizeFields {
  id: string
  period_id: string
  board: Board
  rank: PrizeRank
  status: "active" | "cancelled"
  cancelled_at: string | null
  created_at: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

function money(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

/** "GH₵50 Cash", "GH₵20 MTN Airtime", "15 days Dealer upgrade"; data bundles use the package name. */
export function defaultPrizeLabel(f: Omit<PrizeFields, "label">, packageName?: string | null): string {
  const cedis = (n: number | null) => `GH₵${(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
  switch (f.prize_type) {
    case "wallet_topup": return `${cedis(f.amount)} Cash`
    case "airtime": return `${cedis(f.amount)} ${f.network ?? ""} Airtime`.replace(/\s+/g, " ")
    case "data_bundle": return packageName?.trim() || "Data bundle"
    case "role_upgrade": return `${f.duration_days ?? 0} days Dealer upgrade`
    case "manual": return "Prize"
  }
}

/** Validates admin input into the exact fields stored. `packageName` fills a blank data-bundle label. */
export function validatePrize(raw: unknown, packageName?: string | null): Result<PrizeFields> {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const type = r.prize_type
  if (typeof type !== "string" || !(PRIZE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: "Choose a prize type" }
  }
  const fields: Omit<PrizeFields, "label"> = {
    prize_type: type as PrizeType, amount: null, package_id: null, network: null, role: null, duration_days: null,
  }

  switch (fields.prize_type) {
    case "wallet_topup": {
      const amount = money(r.amount)
      if (amount === null || amount <= 0 || amount > MAX_WALLET_PRIZE) return { ok: false, error: `Cash amount must be between GH₵0.01 and GH₵${MAX_WALLET_PRIZE.toLocaleString("en-US")}` }
      fields.amount = amount
      break
    }
    case "airtime": {
      const amount = money(r.amount)
      if (amount === null || amount <= 0 || amount > MAX_AIRTIME_PRIZE) return { ok: false, error: `Airtime amount must be between GH₵0.01 and GH₵${MAX_AIRTIME_PRIZE.toLocaleString("en-US")}` }
      if (typeof r.network !== "string" || !(AIRTIME_NETWORKS as readonly string[]).includes(r.network)) return { ok: false, error: "Choose the airtime network" }
      fields.amount = amount
      fields.network = r.network
      break
    }
    case "data_bundle": {
      if (typeof r.package_id !== "string" || !UUID.test(r.package_id)) return { ok: false, error: "Choose the data bundle" }
      fields.package_id = r.package_id
      break
    }
    case "role_upgrade": {
      const days = typeof r.duration_days === "number" ? r.duration_days : Number(r.duration_days)
      if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, error: "Upgrade length must be 1 to 365 days" }
      fields.role = "dealer"
      fields.duration_days = days
      break
    }
    case "manual":
      break
  }

  const typed = typeof r.label === "string" ? r.label.trim().replace(/\s+/g, " ") : ""
  if (!typed && fields.prize_type === "manual") return { ok: false, error: "Describe the prize" }
  const label = typed || defaultPrizeLabel(fields, packageName)
  if (label.length > MAX_LABEL) return { ok: false, error: `Prize name must be at most ${MAX_LABEL} characters` }
  return { ok: true, value: { ...fields, label } }
}

export function validatePresetName(v: unknown): Result<string> {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : ""
  if (!name) return { ok: false, error: "Give the preset a name" }
  if (name.length > MAX_PRESET_NAME) return { ok: false, error: `Preset name must be at most ${MAX_PRESET_NAME} characters` }
  return { ok: true, value: name }
}

export function isBoard(v: unknown): v is Board {
  return typeof v === "string" && (BOARDS as readonly string[]).includes(v)
}

export function isPrizeRank(v: unknown): v is PrizeRank {
  return v === 1 || v === 2 || v === 3
}

/** "MTN 10GB" from a packages row (the table has no name column; size is the GB figure, e.g. "10"). */
export function bundleLabel(network: string | null | undefined, size: string | number | null | undefined): string {
  const s = String(size ?? "").trim()
  const gb = s && /^\d+(\.\d+)?$/.test(s) ? `${s}GB` : s
  return [network?.trim(), gb].filter(Boolean).join(" ") || "Data bundle"
}

/** "GH₵50 CASH (Wallet top-up)" as on the Prizes tab. */
export function prizeSummary(p: Pick<PrizeFields, "label" | "prize_type">): string {
  return `${p.label} (${PRIZE_TYPE_LABEL[p.prize_type]})`
}

/** Ranks still missing an active prize, in board order: "dashboard rank 1". */
export function missingPrizes(prizes: Pick<PrizeRow, "board" | "rank" | "status">[]): string[] {
  const missing: string[] = []
  for (const board of BOARDS) {
    for (const rank of PRIZE_RANKS) {
      if (!prizes.some((p) => p.board === board && p.rank === rank && p.status === "active")) missing.push(`${board} rank ${rank}`)
    }
  }
  return missing
}
