import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function DELETE(req: NextRequest) {
  try {
    // Verify admin access (checks both user_metadata and users table)
    const { isAdmin, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) {
      return errorResponse
    }

    const { userId } = await req.json()

    if (!userId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 })
    }

    // Create Supabase client with service role for admin operations
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    console.log(`[REMOVE-USER] Admin removing user ${userId}`)

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

    // 6b. Delete shop_invites where this user was invited (before processing shops)
    const { error: invitedAsUserError } = await supabaseAdmin
      .from("shop_invites")
      .delete()
      .eq("invited_user_id", userId)
    
    if (invitedAsUserError) {
      console.warn(`[REMOVE-USER] Warning deleting shop_invites (as invited user): ${invitedAsUserError.message}`)
    }

    // 7. Delete user shops and related data
    const { data: shops } = await supabaseAdmin
      .from("user_shops")
      .select("id, parent_shop_id")
      .eq("user_id", userId)

    if (shops && shops.length > 0) {
      const shopIds = shops.map(s => s.id)
      
      // Delete shop_invites where this shop is the inviter
      const { error: shopInvitesError } = await supabaseAdmin
        .from("shop_invites")
        .delete()
        .in("inviter_shop_id", shopIds)
      
      if (shopInvitesError) {
        console.warn(`[REMOVE-USER] Warning deleting shop_invites: ${shopInvitesError.message}`)
      }

      // Delete shop_invites where this user was the invited user
      const { error: invitedByError } = await supabaseAdmin
        .from("shop_invites")
        .delete()
        .eq("invited_user_id", userId)
      
      if (invitedByError) {
        console.warn(`[REMOVE-USER] Warning deleting shop_invites (invited_user): ${invitedByError.message}`)
      }
      
      // Delete sub_agent_shop_packages (sub-agent inventory)
      const { error: subAgentShopPackagesError } = await supabaseAdmin
        .from("sub_agent_shop_packages")
        .delete()
        .in("shop_id", shopIds)
      
      if (subAgentShopPackagesError) {
        console.warn(`[REMOVE-USER] Warning deleting sub_agent_shop_packages: ${subAgentShopPackagesError.message}`)
      }

      // Delete sub_agent_catalog (parent's sub-agent offerings)
      const { error: subAgentCatalogError } = await supabaseAdmin
        .from("sub_agent_catalog")
        .delete()
        .in("shop_id", shopIds)
      
      if (subAgentCatalogError) {
        console.warn(`[REMOVE-USER] Warning deleting sub_agent_catalog: ${subAgentCatalogError.message}`)
      }

      // Nullify parent_shop_id references on other shops (so their sub-agents aren't orphaned with broken FK)
      const { error: orphanSubAgentsError } = await supabaseAdmin
        .from("user_shops")
        .update({ parent_shop_id: null })
        .in("parent_shop_id", shopIds)
      
      if (orphanSubAgentsError) {
        console.warn(`[REMOVE-USER] Warning nullifying parent_shop_id: ${orphanSubAgentsError.message}`)
      }

      // Nullify parent_shop_id on shop_orders that reference these shops
      const { error: orphanOrdersError } = await supabaseAdmin
        .from("shop_orders")
        .update({ parent_shop_id: null })
        .in("parent_shop_id", shopIds)
      
      if (orphanOrdersError) {
        console.warn(`[REMOVE-USER] Warning nullifying shop_orders.parent_shop_id: ${orphanOrdersError.message}`)
      }

      // Delete shop_customers
      const { error: shopCustomersError } = await supabaseAdmin
        .from("shop_customers")
        .delete()
        .in("shop_id", shopIds)
      
      if (shopCustomersError) {
        console.warn(`[REMOVE-USER] Warning deleting shop_customers: ${shopCustomersError.message}`)
      }

      // Delete shop_packages
      const { error: shopPackagesError } = await supabaseAdmin
        .from("shop_packages")
        .delete()
        .in("shop_id", shopIds)
      
      if (shopPackagesError) {
        console.warn(`[REMOVE-USER] Warning deleting shop_packages: ${shopPackagesError.message}`)
      }

      // Delete shop_available_balance
      const { error: shopBalanceError } = await supabaseAdmin
        .from("shop_available_balance")
        .delete()
        .in("shop_id", shopIds)
      
      if (shopBalanceError) {
        console.warn(`[REMOVE-USER] Warning deleting shop_available_balance: ${shopBalanceError.message}`)
      }

      // Delete shop_profits
      const { error: shopProfitsError } = await supabaseAdmin
        .from("shop_profits")
        .delete()
        .in("shop_id", shopIds)
      
      if (shopProfitsError) {
        console.warn(`[REMOVE-USER] Warning deleting shop_profits: ${shopProfitsError.message}`)
      }

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
