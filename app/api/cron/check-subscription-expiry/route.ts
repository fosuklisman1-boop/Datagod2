import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Cron job endpoint to check and send subscription expiry reminders
 * Should be called hourly via Vercel Cron or external cron service
 * 
 * Sends reminders at: 1 day, 12 hours, 6 hours, and 1 hour before expiry
 */
export async function GET(request: NextRequest) {
    try {
        console.log("[CRON-SUBSCRIPTION] Starting subscription expiry check...")

        const now = new Date()

        // Define time windows for each reminder type (in milliseconds)
        const TIME_WINDOWS = {
            '1day': { start: 24 * 60 * 60 * 1000, end: 23 * 60 * 60 * 1000 }, // 23-24 hours
            '12hours': { start: 12 * 60 * 60 * 1000, end: 11 * 60 * 60 * 1000 }, // 11-12 hours
            '6hours': { start: 6 * 60 * 60 * 1000, end: 5 * 60 * 60 * 1000 }, // 5-6 hours
            '1hour': { start: 60 * 60 * 1000, end: 0 }, // 0-1 hour
        }

        const results = {
            checked: 0,
            sent: 0,
            skipped: 0,
            errors: 0,
        }

        // Get all active subscriptions
        const { data: subscriptions, error: fetchError } = await supabase
            .from("user_subscriptions")
            .select(`
        id,
        user_id,
        plan_id,
        end_date,
        status,
        plan:subscription_plans(name)
      `)
            .eq("status", "active")

        if (fetchError) {
            console.error("[CRON-SUBSCRIPTION] Error fetching subscriptions:", fetchError)
            return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 })
        }

        console.log(`[CRON-SUBSCRIPTION] Found ${subscriptions?.length || 0} active subscriptions`)

        for (const sub of subscriptions || []) {
            results.checked++

            const endDate = new Date(sub.end_date)
            const timeUntilExpiry = endDate.getTime() - now.getTime()

            // Skip if already expired
            if (timeUntilExpiry <= 0) {
                continue
            }

            // Check which reminder(s) to send
            for (const [reminderType, window] of Object.entries(TIME_WINDOWS)) {
                if (timeUntilExpiry <= window.start && timeUntilExpiry > window.end) {
                    // Check if this reminder was already sent
                    const { data: existingReminder } = await supabase
                        .from("subscription_reminders")
                        .select("id")
                        .eq("subscription_id", sub.id)
                        .eq("reminder_type", reminderType)
                        .maybeSingle()

                    if (existingReminder) {
                        console.log(`[CRON-SUBSCRIPTION] Reminder ${reminderType} already sent for subscription ${sub.id}`)
                        results.skipped++
                        continue
                    }

                    // Get user's phone number and verify dealer role
                    const { data: userData } = await supabase
                        .from("users")
                        .select("phone_number, role")
                        .eq("id", sub.user_id)
                        .single()

                    if (!userData?.phone_number) {
                        console.warn(`[CRON-SUBSCRIPTION] User ${sub.user_id} has no phone number, skipping`)
                        results.skipped++
                        continue
                    }

                    // Only send to dealers (users with active subscriptions should be dealers, but double-check)
                    if (userData.role !== "dealer") {
                        console.warn(`[CRON-SUBSCRIPTION] User ${sub.user_id} is not a dealer, skipping`)
                        results.skipped++
                        continue
                    }

                    try {
                        // Format end date
                        const formattedEndDate = endDate.toLocaleDateString('en-GB', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        })

                        const planName = (sub.plan as any)?.name || "Dealer"

                        // Select appropriate template
                        let message = ""
                        switch (reminderType) {
                            case '1day':
                                message = SMSTemplates.subscriptionExpiry1Day(planName, formattedEndDate)
                                break
                            case '12hours':
                                message = SMSTemplates.subscriptionExpiry12Hours(planName, formattedEndDate)
                                break
                            case '6hours':
                                message = SMSTemplates.subscriptionExpiry6Hours(planName, formattedEndDate)
                                break
                            case '1hour':
                                message = SMSTemplates.subscriptionExpiry1Hour(planName, formattedEndDate)
                                break
                        }

                        // Send SMS
                        const smsResult = await sendSMS({
                            phone: userData.phone_number,
                            message,
                            type: `subscription_expiry_${reminderType}`,
                            reference: sub.id,
                            userId: sub.user_id,
                        })

                        if (smsResult.success) {
                            // Record that reminder was sent
                            await supabase
                                .from("subscription_reminders")
                                .insert({
                                    subscription_id: sub.id,
                                    reminder_type: reminderType,
                                })

                            console.log(`[CRON-SUBSCRIPTION] ✓ Sent ${reminderType} reminder to user ${sub.user_id}`)
                            results.sent++
                        } else {
                            console.error(`[CRON-SUBSCRIPTION] Failed to send ${reminderType} reminder:`, smsResult.error)
                            results.errors++
                        }
                    } catch (smsError) {
                        console.error(`[CRON-SUBSCRIPTION] Error sending ${reminderType} reminder:`, smsError)
                        results.errors++
                    }
                }
            }
        }

        console.log("[CRON-SUBSCRIPTION] Completed subscription expiry check:", results)

        return NextResponse.json({
            success: true,
            ...results,
        })
    } catch (error) {
        console.error("[CRON-SUBSCRIPTION] Fatal error:", error)
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        )
    }
}
