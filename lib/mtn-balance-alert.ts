import { supabaseAdmin as supabase } from "@/lib/supabase"

function buildLowBalanceLines(
  balances: Record<string, number | null>,
  lows: Record<string, boolean>
): string[] {
  const labels: Record<string, string> = {
    sykes: "Sykes", datakazina: "DataKazina", xpress: "Xpress",
    eazyghdata: "EazyGhData", bisdel: "Bisdel", codecraft: "CodeCraft",
  }
  return Object.entries(lows)
    .filter(([k, v]) => v && balances[k] !== null)
    .map(([k]) => `${labels[k]}: ₵${(balances[k] as number).toFixed(2)} (LOW)`)
}

/**
 * Send SMS + email alert when any provider balance is below threshold.
 * Uses the same notifyAdmins() path as every other alert in the app —
 * reads admin phones from admin_notification_phones / users.role='admin'.
 * Debounced to once per hour via the last_balance_alert admin_settings key.
 */
export async function sendLowBalanceAlert(
  balances: Record<string, number | null>,
  lows: Record<string, boolean>,
  threshold: number
): Promise<void> {
  try {
    // 1-hour debounce
    const { data: recentAlert } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "last_balance_alert")
      .maybeSingle()

    const lastAlertTime = recentAlert?.value?.timestamp ? new Date(recentAlert.value.timestamp) : null
    const now = new Date()

    if (lastAlertTime && (now.getTime() - lastAlertTime.getTime()) < 3600000) {
      console.log("[Balance Alert] Sent recently, skipping")
      return
    }

    const lines = buildLowBalanceLines(balances, lows)
    if (lines.length === 0) return

    const smsMessage = `⚠️ MTN WALLET ALERT\n\n${lines.join("\n")}\n\nThreshold: ₵${threshold}\nPlease top up your MTN account(s).`

    // SMS via main notifyAdmins() — reads admin_notification_phones, same as every other alert
    const { notifyAdmins: sendAdminSMS } = await import("@/lib/sms-service")
    await sendAdminSMS(smsMessage, "balance_alert", "mtn_balance", true).catch(
      (e) => console.error("[Balance Alert] SMS error:", e)
    )

    // Email
    const emailRows = lines.map(
      (l) => `<p style="margin:10px 0"><strong>${l.split(": ")[0]}:</strong> ${l.split(": ")[1]}</p>`
    ).join("")

    const emailHtml = `
      <div style="text-align:center">
        <h2 style="color:#dc2626">⚠️ MTN Wallet Balance Alert</h2>
        <p>One or more provider balances have fallen below the threshold.</p>
      </div>
      <div style="background:#fee2e2;border-radius:8px;padding:20px;border:1px solid #fca5a5;margin:20px 0">
        <h3 style="margin-top:0;color:#991b1b">Low Balance Details:</h3>
        ${emailRows}
        <p style="margin:15px 0 0;padding-top:15px;border-top:1px solid #fca5a5">
          <strong>Alert Threshold:</strong> ₵${threshold}
        </p>
      </div>
      <div style="background:#fef3c7;border-radius:8px;padding:15px;border:1px solid #fbbf24">
        <p style="margin:0;color:#92400e">
          <strong>⚠️ Action Required:</strong> Please top up your MTN account(s) to avoid service disruption.
        </p>
      </div>`

    const { notifyAdmins: sendAdminEmail } = await import("@/lib/email-service")
    await sendAdminEmail("⚠️ MTN Wallet Balance Alert – Low Balance Detected", emailHtml).catch(
      (e) => console.error("[Balance Alert] Email error:", e)
    )

    // Record timestamp for debounce
    await supabase.from("admin_settings").upsert(
      { key: "last_balance_alert", value: { timestamp: now.toISOString() } },
      { onConflict: "key" }
    )

    console.log("[Balance Alert] Alerts dispatched")
  } catch (error) {
    console.error("[Balance Alert] Failed:", error)
  }
}
