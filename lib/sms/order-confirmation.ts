/**
 * Whether a shop may bill its order confirmations to its own sender ID: the shop's SMS account
 * (sms_accounts.user_id = user_shops.user_id) must be 'active' and have an active own sender ID.
 * Never throws — any lookup failure is ok:false so callers refuse/fall back to the free sender.
 */
import { createClient } from "@supabase/supabase-js"
import { loadDefaultSender } from "./default-sender"

export type OwnSenderCheck = {
  ok: boolean
  reason?: string
  accountId?: string
  userId?: string
  senderId?: string
}

type Db = { from: (table: string) => any }

let admin: Db | null = null
function defaultDb(): Db {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return admin
}

export async function canUseOwnSenderForConfirmations(shopId: string, db?: Db): Promise<OwnSenderCheck> {
  try {
    const client = db ?? defaultDb()
    const { data: shop, error: shopErr } = await client.from("user_shops").select("user_id").eq("id", shopId).maybeSingle()
    if (shopErr) return { ok: false, reason: "Could not look up your shop. Try again." }
    const userId = (shop as { user_id?: string } | null)?.user_id
    if (!userId) return { ok: false, reason: "Shop not found." }

    const { data: acct, error: acctErr } = await client
      .from("sms_accounts")
      .select("id, status")
      .eq("user_id", userId)
      .maybeSingle()
    if (acctErr) return { ok: false, reason: "Could not look up your SMS account. Try again." }
    const account = acct as { id?: string; status?: string } | null
    if (!account?.id) return { ok: false, reason: "Set up Bulk SMS first to use your own sender ID for order confirmations." }
    if (account.status !== "active") return { ok: false, reason: "Your SMS account is not active." }

    const senderId = await loadDefaultSender(client, account.id)
    if (!senderId) return { ok: false, reason: "You need an active sender ID to use it for order confirmations." }

    return { ok: true, accountId: account.id, userId, senderId }
  } catch {
    return { ok: false, reason: "Could not verify your sender ID. Try again." }
  }
}
