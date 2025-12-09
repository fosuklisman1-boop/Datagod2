import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await req.json()

    if (!userId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 })
    }

    // Get authorization token from headers
    const authHeader = req.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)

    // Create Supabase client with service role for admin operations
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Verify user is admin using the token
    const { data: { user: currentUser }, error: userError } = await supabaseAdmin.auth.getUser(token)

    if (userError || !currentUser) {
      return NextResponse.json(
        { error: "Invalid authentication token" },
        { status: 401 }
      )
    }

    // Check if user is admin
    const { data: userData } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", currentUser.id)
      .single()

    if (userData?.role !== "admin") {
      return NextResponse.json(
        { error: "User not allowed to perform this action" },
        { status: 403 }
      )
    }

    console.log(`[REMOVE-USER] Admin ${currentUser.id} removing user ${userId}`)

    // Delete all related data (in reverse order of dependencies)
    // These have ON DELETE CASCADE, but we'll explicitly delete for logging and safety

    // 1. Delete notifications
    const { error: notifError } = await supabaseAdmin
      .from("notifications")
      .delete()
      .eq("user_id", userId)
    
    if (notifError) {
      console.warn(`[REMOVE-USER] Warning deleting notifications: ${notifError.message}`)
    }

    // 2. Delete complaints
    const { error: complaintError } = await supabaseAdmin
      .from("complaints")
      .delete()
      .eq("user_id", userId)
    
    if (complaintError) {
      console.warn(`[REMOVE-USER] Warning deleting complaints: ${complaintError.message}`)
    }

    // 3. Delete transactions
    const { error: transactionError } = await supabaseAdmin
      .from("transactions")
      .delete()
      .eq("user_id", userId)
    
    if (transactionError) {
      console.warn(`[REMOVE-USER] Warning deleting transactions: ${transactionError.message}`)
    }

    // 4. Delete withdrawal requests
    const { error: withdrawalError } = await supabaseAdmin
      .from("withdrawal_requests")
      .delete()
      .eq("user_id", userId)
    
    if (withdrawalError) {
      console.warn(`[REMOVE-USER] Warning deleting withdrawal requests: ${withdrawalError.message}`)
    }

    // 5. Delete orders
    const { error: ordersError } = await supabaseAdmin
      .from("orders")
      .delete()
      .eq("user_id", userId)
    
    if (ordersError) {
      console.warn(`[REMOVE-USER] Warning deleting orders: ${ordersError.message}`)
    }

    // 6. Delete AFA orders
    const { error: afaError } = await supabaseAdmin
      .from("afa_orders")
      .delete()
      .eq("user_id", userId)
    
    if (afaError) {
      console.warn(`[REMOVE-USER] Warning deleting AFA orders: ${afaError.message}`)
    }

    // 7. Delete user shops and related data
    const { data: shops } = await supabaseAdmin
      .from("user_shops")
      .select("id")
      .eq("user_id", userId)

    if (shops && shops.length > 0) {
      const shopIds = shops.map(s => s.id)
      
      // Delete shop orders
      const { error: shopOrderError } = await supabaseAdmin
        .from("shop_orders")
        .delete()
        .in("shop_id", shopIds)
      
      if (shopOrderError) {
        console.warn(`[REMOVE-USER] Warning deleting shop orders: ${shopOrderError.message}`)
      }

      // Delete shops
      const { error: shopsError } = await supabaseAdmin
        .from("user_shops")
        .delete()
        .eq("user_id", userId)
      
      if (shopsError) {
        console.warn(`[REMOVE-USER] Warning deleting shops: ${shopsError.message}`)
      }
    }

    // 8. Delete wallet
    const { error: walletError } = await supabaseAdmin
      .from("wallets")
      .delete()
      .eq("user_id", userId)
    
    if (walletError) {
      console.warn(`[REMOVE-USER] Warning deleting wallet: ${walletError.message}`)
    }

    // 9. Delete user profile
    const { error: profileError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", userId)

    if (profileError) {
      console.error("Error deleting user profile:", profileError)
      // Continue - user still needs to be deleted from auth
    }

    // 10. Delete user from auth (this is the critical operation)
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)

    if (deleteError) {
      console.error("Error deleting user from auth:", deleteError)
      return NextResponse.json(
        { error: deleteError.message || "Failed to delete user from authentication" },
        { status: 400 }
      )
    }

    console.log(`[REMOVE-USER] User ${userId} successfully removed`)

    return NextResponse.json({
      success: true,
      message: "User and all associated data deleted successfully",
      deleted: {
        auth: true,
        profile: !profileError,
        wallet: !walletError,
        orders: !ordersError,
        afarders: !afaError,
        transactions: !transactionError,
        withdrawals: !withdrawalError,
        complaints: !complaintError,
        notifications: !notifError,
        shops: shops ? shops.length : 0,
      }
    })
  } catch (error: any) {
    console.error("Error in DELETE /api/admin/remove-user:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
