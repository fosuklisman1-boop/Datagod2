import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendSMS } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * GET /api/admin/blacklist
 * Fetch all blacklisted phone numbers
 */
export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const { searchParams } = new URL(request.url)
    const search = searchParams.get("search") || ""
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = parseInt(searchParams.get("offset") || "0")

    let query = supabase
      .from("blacklisted_phone_numbers")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (search) {
      query = query.ilike("phone_number", `%${search}%`)
    }

    const { data, error, count } = await query

    if (error) {
      console.error("[BLACKLIST] Error fetching blacklist:", error)
      return NextResponse.json(
        { error: "Failed to fetch blacklist" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: data || [],
      count: count || 0,
      pagination: {
        limit,
        offset,
        hasMore: (count || 0) > offset + limit,
      },
    })
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/admin/blacklist
 * Add phone number(s) to blacklist - supports single or space-separated numbers
 */
export async function POST(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const body = await request.json()
    let { phone_number, reason } = body

    if (!phone_number) {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      )
    }

    // Support space-separated phone numbers
    const phoneNumbers = phone_number
      .split(/\s+/) // Split by whitespace
      .filter((num: string) => num.trim().length > 0) // Remove empty strings
      .map((num: string) => num.trim())

    if (phoneNumbers.length === 0) {
      return NextResponse.json(
        { error: "No valid phone numbers provided" },
        { status: 400 }
      )
    }

    // Create array of objects for bulk insert
    const recordsToInsert = phoneNumbers.map((num: string) => ({
      phone_number: num,
      reason: reason || null,
      created_by: null, // Will be set by RLS if available
    }))

    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .insert(recordsToInsert)
      .select()

    if (error) {
      console.error("[BLACKLIST] Error adding to blacklist:", error)
      return NextResponse.json(
        { error: error.message || "Failed to add to blacklist" },
        { status: 500 }
      )
    }

    console.log(`[BLACKLIST] ✓ Added ${phoneNumbers.length} phone number(s) to blacklist`)

    return NextResponse.json({
      success: true,
      message: `Added ${phoneNumbers.length} phone number(s) to blacklist`,
      data: data || [],
      addedCount: phoneNumbers.length,
    })
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/admin/blacklist?phone=...
 * Remove phone number from blacklist
 */
export async function DELETE(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const { searchParams } = new URL(request.url)
    const phone = searchParams.get("phone")

    if (!phone) {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      )
    }

    const { error } = await supabase
      .from("blacklisted_phone_numbers")
      .delete()
      .eq("phone_number", phone)

    if (error) {
      console.error("[BLACKLIST] Error removing from blacklist:", error)
      return NextResponse.json(
        { error: "Failed to remove from blacklist" },
        { status: 500 }
      )
    }

    // Update shop_orders: reset blacklisted orders back to pending if they haven't been processed
    const { data: shopOrdersUpdated, error: shopOrdersError } = await supabase
      .from("shop_orders")
      .update({
        order_status: "pending",
        queue: "default",
        updated_at: new Date().toISOString(),
      })
      .eq("customer_phone", phone)
      .eq("order_status", "blacklisted")
      .select()

    if (shopOrdersError) {
      console.error("[BLACKLIST] Error updating shop_orders:", shopOrdersError)
    } else if (shopOrdersUpdated && shopOrdersUpdated.length > 0) {
      console.log(`[BLACKLIST] ✓ Updated ${shopOrdersUpdated.length} shop_orders back to pending for phone: ${phone}`)
      
      // Send SMS notification to customers about their orders being cleared
      for (const order of shopOrdersUpdated) {
        try {
          const notificationSMS = `DATAGOD: Great news! Your ${order.network} ${order.volume_gb}GB order to ${order.customer_phone} has been cleared for fulfillment. Your data will be delivered shortly.`
          await sendSMS({
            phone: order.customer_phone,
            message: notificationSMS,
            type: 'order_cleared',
            reference: order.id,
          }).catch(err => console.error("[BLACKLIST] SMS error for order", order.id, ":", err))
        } catch (smsError) {
          console.warn("[BLACKLIST] Failed to send cleared notification for order", order.id, ":", smsError)
        }
      }
    }

    // Update orders (wallet): reset blacklisted orders back to pending if they haven't been processed
    const { data: ordersUpdated, error: ordersError } = await supabase
      .from("orders")
      .update({
        status: "pending",
        queue: "default",
        updated_at: new Date().toISOString(),
      })
      .eq("phone_number", phone)
      .eq("status", "blacklisted")
      .select()

    if (ordersError) {
      console.error("[BLACKLIST] Error updating orders:", ordersError)
    } else if (ordersUpdated && ordersUpdated.length > 0) {
      console.log(`[BLACKLIST] ✓ Updated ${ordersUpdated.length} orders back to pending for phone: ${phone}`)
      
      // Send SMS notification to customers about their orders being cleared
      for (const order of ordersUpdated) {
        try {
          const notificationSMS = `DATAGOD: Great news! Your order to ${order.phone_number} has been cleared for fulfillment. Your data will be delivered shortly.`
          await sendSMS({
            phone: order.phone_number,
            message: notificationSMS,
            type: 'order_cleared',
            reference: order.id,
          }).catch(err => console.error("[BLACKLIST] SMS error for order", order.id, ":", err))
        } catch (smsError) {
          console.warn("[BLACKLIST] Failed to send cleared notification for order", order.id, ":", smsError)
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `Removed ${phone} from blacklist`,
      shopOrdersUpdated: shopOrdersUpdated?.length || 0,
      wallletOrdersUpdated: ordersUpdated?.length || 0,
    })
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
