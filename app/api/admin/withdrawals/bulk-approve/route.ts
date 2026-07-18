import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { initiateTransfer, getMoolreTransferBalance } from "@/lib/moolre-transfer"
import { sendPushToUser } from "@/lib/push-service"
import { notificationTemplates } from "@/lib/notification-service"

// Serial processing of N transfers can take several seconds each
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface BulkResult {
  id: string
  shopName: string
  amount: number
  success: boolean
  status: string
  message: string
}

/** Fire-and-forget in-app + push notification to the shop owner. */
async function notifyOwner(shopId: string, amount: number, withdrawalId: string, succeeded: boolean) {
  try {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("user_id, shop_name")
      .eq("id", shopId)
      .single()
    if (!shop) return

    const notif = succeeded
      ? notificationTemplates.withdrawalApproved(amount, withdrawalId)
      : { title: "Transfer Failed", message: `Your GHS ${amount.toFixed(2)} withdrawal could not be processed. It remains pending.`, type: "order_update" as const, reference_id: withdrawalId }

    await supabase.from("notifications").insert([{
      user_id: shop.user_id,
      title: notif.title,
      message: notif.message,
      type: notif.type,
      reference_id: notif.reference_id ?? withdrawalId,
      action_url: "/dashboard/shop-dashboard",
      read: false,
    }])

    sendPushToUser(shop.user_id, {
      title: notif.title,
      body: notif.message,
      data: { url: "/dashboard/shop-dashboard" },
    }).catch(() => {})
  } catch {
    // Notification failure must never block the batch result
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalIds, manual = false } = await request.json()

    if (!Array.isArray(withdrawalIds) || withdrawalIds.length === 0) {
      return NextResponse.json({ error: "No withdrawal IDs provided" }, { status: 400 })
    }
    if (withdrawalIds.length > 50) {
      return NextResponse.json({ error: "Maximum 50 withdrawals per batch" }, { status: 400 })
    }

    // Fetch only eligible (pending/failed) records
    const { data: eligible, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, fee_amount, net_amount, withdrawal_method, account_details, status")
      .in("id", withdrawalIds)
      .in("status", ["pending", "failed"])

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    const found = eligible || []
    const skippedIds = withdrawalIds.filter(id => !found.find(w => w.id === id))

    if (found.length === 0) {
      return NextResponse.json(
        { error: "None of the selected withdrawals are in pending or failed status" },
        { status: 400 }
      )
    }

    // Solvency check — skip for manual (admin is handling the transfer themselves)
    if (!manual) {
      const totalNet = found.reduce((sum, w) => sum + Number(w.net_amount ?? w.amount), 0)
      const wallet = await getMoolreTransferBalance()

      if (!wallet) {
        return NextResponse.json(
          { error: "Could not verify Moolre wallet balance. Use manual approval or try again." },
          { status: 503 }
        )
      }

      if (wallet.balance < totalNet) {
        return NextResponse.json({
          error: `Insufficient Moolre balance. Need GHS ${totalNet.toFixed(2)} but wallet has GHS ${wallet.balance.toFixed(2)}.`,
          moolreBalance: wallet.balance,
          totalRequired: totalNet,
          shortfall: totalNet - wallet.balance,
        }, { status: 400 })
      }

      console.log(`[BULK-APPROVE] Solvency OK: wallet=GHS ${wallet.balance.toFixed(2)}, needed=GHS ${totalNet.toFixed(2)}`)
    }

    // Fetch shop names for result labels
    const shopIds = [...new Set(found.map(w => w.shop_id))]
    const { data: shops } = await supabase
      .from("user_shops")
      .select("id, shop_name")
      .in("id", shopIds)
    const shopNameMap = Object.fromEntries((shops || []).map(s => [s.id, s.shop_name]))

    // Serial processing loop — Moolre docs recommend serial/small batches to avoid rate limits
    const results: BulkResult[] = []

    for (const w of found) {
      const shopName = shopNameMap[w.shop_id] || w.shop_id.slice(0, 8)
      const amount = Number(w.amount)
      const netAmount = Number(w.net_amount ?? w.amount)

      try {
        // Atomic lock — only succeeds if still pending/failed (prevents double-spend)
        const { data: locked, error: lockErr } = await supabase
          .from("withdrawal_requests")
          .update({
            status: "processing",
            transfer_attempted_at: new Date().toISOString(),
            moolre_external_ref: w.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", w.id)
          .in("status", ["pending", "failed"])
          .select("id, shop_id, amount, net_amount, fee_amount, account_details, withdrawal_method")
          .single()

        if (lockErr || !locked) {
          results.push({ id: w.id, shopName, amount, success: false, status: "skipped", message: "Already locked by another process" })
          continue
        }

        // Manual approval — mark as approved, notify, move on
        if (manual) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "approved", updated_at: new Date().toISOString() })
            .eq("id", locked.id)

          notifyOwner(locked.shop_id, amount, locked.id, true).catch(() => {})
          results.push({ id: locked.id, shopName, amount, success: true, status: "approved", message: "Manually approved" })
          continue
        }

        // Auto transfer via Moolre
        const details = locked.account_details as any
        const isBankTransfer = locked.withdrawal_method === "bank_transfer"
        const transferAmount = Number(locked.net_amount ?? locked.amount)

        if (!isFinite(transferAmount) || transferAmount <= 0) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: "Invalid transfer amount" })
          continue
        }

        const transferResult = await initiateTransfer(
          isBankTransfer
            ? { accountNumber: details?.account_number, sublistid: details?.sublistid, network: "BANK", amount: transferAmount, externalref: locked.id, reference: `Datagod withdrawal ${locked.id.slice(0, 8)}` }
            : { phone: details?.phone, network: details?.network, amount: transferAmount, externalref: locked.id, reference: `Datagod withdrawal ${locked.id.slice(0, 8)}` }
        )

        if (!transferResult) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: "Payment provider unreachable" })
          continue
        }

        if (transferResult.txstatus === 1) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "completed", moolre_transfer_id: transferResult.transactionId, moolre_fee: transferResult.fee, transfer_completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          notifyOwner(locked.shop_id, amount, locked.id, true).catch(() => {})
          results.push({ id: locked.id, shopName, amount, success: true, status: "completed", message: `Sent — TX: ${transferResult.transactionId}` })

        } else if (transferResult.txstatus === 2) {
          const reason = transferResult.insufficientBalance
            ? "Insufficient Moolre balance (check wallet)"
            : transferResult.errorMessage || "Transfer rejected by provider"
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          notifyOwner(locked.shop_id, amount, locked.id, false).catch(() => {})
          results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: reason })

        } else {
          // txstatus 0 (pending MoMo confirmation) or 3 (unknown) — stays "processing", cron will resolve
          if (transferResult.transactionId) {
            await supabase
              .from("withdrawal_requests")
              .update({ moolre_transfer_id: transferResult.transactionId, updated_at: new Date().toISOString() })
              .eq("id", locked.id)
          }
          const msg = transferResult.txstatus === 0
            ? "Transfer pending MoMo confirmation — monitoring automatically"
            : "Transfer status unknown — monitoring automatically"
          results.push({ id: locked.id, shopName, amount, success: true, status: "processing", message: msg })
        }
      } catch (err: any) {
        console.error(`[BULK-APPROVE] Error processing ${w.id}:`, err)
        results.push({ id: w.id, shopName, amount, success: false, status: "error", message: err.message || "Unexpected error" })
      }
    }

    const succeeded = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length

    console.log(`[BULK-APPROVE] Done: ${succeeded} succeeded, ${failed} failed, ${skippedIds.length} skipped`)

    return NextResponse.json({
      success: true,
      processed: results.length,
      succeeded,
      failed,
      skipped: skippedIds.length,
      results,
    })
  } catch (err: any) {
    console.error("[BULK-APPROVE] Unhandled error:", err)
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 })
  }
}
