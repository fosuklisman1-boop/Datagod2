import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { notifyAdmins } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Network prefix → network name mapping (Ghana)
const NETWORK_PREFIXES: Record<string, string> = {
  "024": "MTN", "054": "MTN", "055": "MTN", "059": "MTN", "025": "MTN",
  "050": "Telecel", "020": "Telecel",
  "027": "AT", "057": "AT", "026": "AT", "028": "AT",
}

function detectNetwork(phone: string): string | null {
  const local = phone.startsWith("0") ? phone : "0" + phone.replace(/^\+233/, "")
  const prefix = local.substring(0, 3)
  return NETWORK_PREFIXES[prefix] || null
}

function generateReference(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const seg = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  return `AT-${seg(3)}-${seg(3)}`
}

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", key)
    .single()
  return data?.value ?? null
}

export async function POST(request: NextRequest) {
  try {
    // 1. Auth
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    // 2. Parse body
    const { network, beneficiaryPhone, airtimeAmount, paySeparately = false, shopId } = await request.json()

    // 3. Validate inputs
    if (!network || !beneficiaryPhone || !airtimeAmount) {
      return NextResponse.json({ error: "network, beneficiaryPhone, and airtimeAmount are required" }, { status: 400 })
    }
    const cleanPhone = beneficiaryPhone.replace(/\s/g, "")
    if (!/^\d{10}$/.test(cleanPhone)) {
      return NextResponse.json({ error: "Phone number must be exactly 10 digits" }, { status: 400 })
    }
    const amount = parseFloat(airtimeAmount)
    if (isNaN(amount) || amount <= 0) {
      return NextResponse.json({ error: "Invalid airtime amount" }, { status: 400 })
    }

    // 4. Check network-specific enable flag
    const networkKey = network.toLowerCase().replace(/\s/g, "_")
    const enableSetting = await getAdminSetting(`airtime_enabled_${networkKey}`)
    if (enableSetting?.enabled === false) {
      return NextResponse.json({ error: `Airtime for ${network} is currently unavailable` }, { status: 503 })
    }

    // 5. Determine Base Cost (Merchant's Role) & Custom Markup
    let merchantRoleFeeRate = 5 // Default Standard Fee
    let customMarkupRate = 0
    let merchantUserId = null

    if (shopId) {
      // Find the merchant (shop owner)
      const { data: shop } = await supabase
        .from("user_shops")
        .select("user_id, airtime_markup_mtn, airtime_markup_telecel, airtime_markup_at")
        .eq("id", shopId)
        .single()
      
      if (shop) {
        merchantUserId = shop.user_id
        
        // Don't apply markup if buying from own shop
        if (merchantUserId !== user.id) {
          customMarkupRate = parseFloat(shop[`airtime_markup_${networkKey}` as keyof typeof shop] as string) || 0
        }

        // Get Merchant's Role to determine the platform base cost
        const { data: merchantProfile } = await supabase
          .from("users")
          .select("role")
          .eq("id", merchantUserId)
          .single()
        
        const isMerchantDealer = merchantProfile?.role === "dealer"
        const merchantFeeKey = isMerchantDealer ? `airtime_fee_${networkKey}_dealer` : `airtime_fee_${networkKey}_customer`
        const merchantFeeSetting = await getAdminSetting(merchantFeeKey)
        merchantRoleFeeRate = merchantFeeSetting?.rate ?? 5
      }
    } else {
      // Buying direct (no shop) — role must come from DB, not user_metadata
      const { data: userProfile } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single()
      const isUserDealer = userProfile?.role === "dealer" || userProfile?.role === "sub_agent"
      const feeKey = isUserDealer ? `airtime_fee_${networkKey}_dealer` : `airtime_fee_${networkKey}_customer`
      const feeSetting = await getAdminSetting(feeKey)
      merchantRoleFeeRate = feeSetting?.rate ?? 5
    }

    const totalFeeRate = merchantRoleFeeRate + customMarkupRate

    // 6. Enforce min/max limits
    const minSetting = await getAdminSetting("airtime_min_amount")
    const maxSetting = await getAdminSetting("airtime_max_amount")
    const minAmount = minSetting?.amount ?? 1
    const maxAmount = maxSetting?.amount ?? 500
    if (amount < minAmount) {
      return NextResponse.json({ error: `Minimum airtime amount is GHS ${minAmount}` }, { status: 400 })
    }
    if (amount > maxAmount) {
      return NextResponse.json({ error: `Maximum airtime amount is GHS ${maxAmount}` }, { status: 400 })
    }

    // 7. Calculate amounts
    let airtimeToRecipient: number
    let totalPaid: number
    const merchantCommissionValue: number = 0 // Wallet purchases are profit-free as per request

    if (paySeparately) {
      airtimeToRecipient = amount
      const totalFeeAmount = parseFloat((amount * totalFeeRate / 100).toFixed(2))
      totalPaid = parseFloat((amount + totalFeeAmount).toFixed(2))
    } else {
      totalPaid = amount
      const totalFeeAmount = parseFloat((amount * totalFeeRate / (100 + totalFeeRate)).toFixed(2))
      airtimeToRecipient = parseFloat((totalPaid - totalFeeAmount).toFixed(2))
    }
    
    // Fee amount stored in DB should be the total fee charged
    const feeAmount = parseFloat((totalPaid - airtimeToRecipient).toFixed(2))

    // 8. Idempotency guard — block same (user, phone, amount) within 30 seconds
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()
    const { data: recentOrder } = await supabase
      .from("airtime_orders")
      .select("id, reference_code")
      .eq("user_id", user.id)
      .eq("beneficiary_phone", cleanPhone)
      .eq("airtime_amount", airtimeToRecipient)
      .neq("status", "failed")
      .gte("created_at", thirtySecondsAgo)
      .maybeSingle()

    if (recentOrder) {
      return NextResponse.json(
        { error: "Duplicate request detected. Please wait before trying again.", reference: recentOrder.reference_code },
        { status: 409 }
      )
    }

    // 9. Atomic wallet deduction (prevents double-spend)
    const { data: deductResult, error: deductError } = await supabase
      .rpc("deduct_wallet", { p_user_id: user.id, p_amount: totalPaid })

    if (deductError) {
      console.error("[AIRTIME] Wallet deduction RPC error:", deductError)
      return NextResponse.json({ error: "Failed to process payment" }, { status: 500 })
    }
    if (!deductResult || deductResult.length === 0) {
      return NextResponse.json(
        { error: "Insufficient wallet balance", required: totalPaid },
        { status: 402 }
      )
    }
    const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

    // 10. Create airtime order record
    const referenceCode = generateReference()
    const { data: order, error: orderError } = await supabase
      .from("airtime_orders")
      .insert([{
        user_id: user.id,
        reference_code: referenceCode,
        network,
        beneficiary_phone: cleanPhone,
        airtime_amount: airtimeToRecipient,
        fee_amount: feeAmount,
        total_paid: totalPaid,
        pay_separately: paySeparately,
        status: "pending",
        payment_status: "completed",
        shop_id: shopId || null,
        merchant_commission: merchantCommissionValue,
      }])
      .select()
      .single()

    if (orderError || !order) {
      // Refund wallet if order creation fails
      console.error("[AIRTIME] Order creation failed, refunding wallet:", orderError)
      await supabase
        .from("wallets")
        .update({ balance: balanceBefore, total_spent: deductResult[0].new_total_spent - totalPaid, updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
      return NextResponse.json({ error: "Failed to create order. Wallet refunded." }, { status: 500 })
    }

    // 11. Create transaction ledger record
    await supabase.from("transactions").insert([{
      user_id: user.id,
      type: "debit",
      source: "airtime_purchase",
      amount: totalPaid,
      balance_before: balanceBefore,
      balance_after: newBalance,
      description: `Airtime: ${network} GHS ${airtimeToRecipient} to ${cleanPhone}`,
      reference_id: order.id,
      status: "completed",
      created_at: new Date().toISOString(),
    }])

    // 12. In-app notification for user
    await supabase.from("notifications").insert([{
      user_id: user.id,
      title: "Airtime Order Placed",
      message: `Your GHS ${airtimeToRecipient} ${network} airtime order for ${cleanPhone} is pending. Ref: ${referenceCode}`,
      type: "order_update",
      reference_id: order.id,
      action_url: `/dashboard/airtime`,
      read: false,
    }])

    // 13. Non-blocking notifications
    try {
      const { data: shopData } = order.shop_id 
        ? await supabase.from("user_shops").select("shop_name").eq("id", order.shop_id).single()
        : { data: null }
      
      const shopName = shopData?.shop_name || "Direct"

      Promise.allSettled([
        // SMS to the beneficiary
        sendSMS({
          phone: cleanPhone,
          message: SMSTemplates.airtimeBeneficiaryNotification(
            shopName,
            network,
            airtimeToRecipient.toString(),
            cleanPhone,
            referenceCode
          ),
          type: "airtime_order_created",
          reference: order.id,
        }),
        // Admin alert
        notifyAdmins(
          SMSTemplates.adminAirtimeOrderNotification(
            shopName,
            cleanPhone,
            airtimeToRecipient.toString(),
            network
          ),
          "airtime_new_order",
          order.id
        ),
        // Admin email alert
        import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
          const payload = EmailTemplates.airtimeAdminAlert(referenceCode, network, cleanPhone, airtimeToRecipient.toFixed(2), totalPaid.toFixed(2))
          return sendEmail({
            to: [],   // notifyAdmins in email-service auto-fetches admin emails
            subject: payload.subject,
            htmlContent: payload.html,
            referenceId: order.id,
            type: "airtime_admin_alert",
          })
        }).catch(e => console.warn("[AIRTIME] Admin email error:", e)),
      ]).catch(e => console.warn("[AIRTIME] Non-blocking notification error:", e))
    } catch (notifErr) {
      console.warn("[AIRTIME] Notification preparation error:", notifErr)
    }

    console.log(`[AIRTIME] ✓ Order created: ${referenceCode} | ${network} GHS ${airtimeToRecipient} → ${cleanPhone}`)

    return NextResponse.json({
      success: true,
      message: "Airtime order placed successfully",
      order: {
        id: order.id,
        reference_code: referenceCode,
        network,
        beneficiary_phone: cleanPhone,
        airtime_amount: airtimeToRecipient,
        fee_amount: feeAmount,
        total_paid: totalPaid,
        status: "pending",
      },
      newBalance,
    })

  } catch (error) {
    console.error("[AIRTIME] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
