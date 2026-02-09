import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Get both formats of a phone number
 */
function getPhoneFormats(phoneNumber: string): string[] {
    const cleaned = phoneNumber.replace(/\D/g, "")
    const withoutZero = cleaned.startsWith("0") ? cleaned.substring(1) : cleaned
    const withZero = cleaned.startsWith("0") ? cleaned : "0" + cleaned
    return [withoutZero, withZero]
}

/**
 * Check if phone is currently blacklisted
 */
async function isPhoneBlacklisted(phone: string): Promise<boolean> {
    const formats = getPhoneFormats(phone)

    const { data, error } = await supabase
        .from("blacklisted_phone_numbers")
        .select("id")
        .in("phone_number", formats)
        .limit(1)

    if (error) {
        console.error("[FIX-ORPHANED] Error checking blacklist:", error)
        return false
    }

    return data && data.length > 0
}

/**
 * POST /api/admin/fix-orphaned-blacklisted
 * Fix orders with "blacklisted" status whose phone numbers are no longer blacklisted
 */
export async function POST(request: NextRequest) {
    try {
        const { isAdmin, errorResponse } = await verifyAdminAccess(request)
        if (!isAdmin) {
            return errorResponse
        }

        console.log("[FIX-ORPHANED] Starting orphaned blacklisted orders fix...")

        // Get all orders with blacklisted status OR blacklisted queue
        const { data: shopOrders } = await supabase
            .from("shop_orders")
            .select("id, customer_phone, order_status, queue")
            .or("order_status.eq.blacklisted,queue.eq.blacklisted")

        const { data: walletOrders } = await supabase
            .from("orders")
            .select("id, phone_number, status, queue")
            .or("status.eq.blacklisted,queue.eq.blacklisted")

        console.log(`[FIX-ORPHANED] Found ${shopOrders?.length || 0} shop orders, ${walletOrders?.length || 0} wallet orders`)

        let shopOrdersFixed = 0
        let walletOrdersFixed = 0
        const details: any[] = []

        // Check shop orders
        if (shopOrders && shopOrders.length > 0) {
            for (const order of shopOrders) {
                const isBlacklisted = await isPhoneBlacklisted(order.customer_phone)

                if (!isBlacklisted) {
                    const { error } = await supabase
                        .from("shop_orders")
                        .update({
                            order_status: "pending",
                            queue: "default",
                            updated_at: new Date().toISOString(),
                        })
                        .eq("id", order.id)

                    if (!error) {
                        shopOrdersFixed++
                        details.push({
                            type: "shop",
                            orderId: order.id,
                            phone: order.customer_phone,
                            action: "fixed"
                        })
                        console.log(`[FIX-ORPHANED] ✓ Fixed shop order ${order.id}`)
                    }
                }
            }
        }

        // Check wallet orders
        if (walletOrders && walletOrders.length > 0) {
            for (const order of walletOrders) {
                const isBlacklisted = await isPhoneBlacklisted(order.phone_number)

                if (!isBlacklisted) {
                    const { error } = await supabase
                        .from("orders")
                        .update({
                            status: "pending",
                            queue: "default",
                            updated_at: new Date().toISOString(),
                        })
                        .eq("id", order.id)

                    if (!error) {
                        walletOrdersFixed++
                        details.push({
                            type: "wallet",
                            orderId: order.id,
                            phone: order.phone_number,
                            action: "fixed"
                        })
                        console.log(`[FIX-ORPHANED] ✓ Fixed wallet order ${order.id}`)
                    }
                }
            }
        }

        console.log(`[FIX-ORPHANED] Complete. Fixed ${shopOrdersFixed + walletOrdersFixed} total orders`)

        return NextResponse.json({
            success: true,
            message: `Fixed ${shopOrdersFixed + walletOrdersFixed} orphaned blacklisted orders`,
            shopOrdersFixed,
            walletOrdersFixed,
            totalFixed: shopOrdersFixed + walletOrdersFixed,
            details,
        })
    } catch (error) {
        console.error("[FIX-ORPHANED] Error:", error)
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        )
    }
}
