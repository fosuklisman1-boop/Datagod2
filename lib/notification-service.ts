import { supabase } from "./supabase"

export type NotificationType = "order_update" | "complaint_resolved" | "payment_success" | "withdrawal_approved" | "withdrawal_rejected" | "balance_updated" | "admin_action"

export interface Notification {
  id: string
  user_id: string
  title: string
  message: string
  type: NotificationType
  read: boolean
  reference_id?: string // Order ID, complaint ID, etc.
  action_url?: string // URL to navigate to
  created_at: string
  updated_at: string
}

export const notificationService = {
  // Create a notification
  async createNotification(
    userId: string,
    title: string,
    message: string,
    type: NotificationType,
    options?: {
      reference_id?: string
      action_url?: string
    }
  ) {
    try {
      console.log("[NOTIFICATION-SERVICE] Creating notification:", {
        userId,
        title,
        type,
        hasReference: !!options?.reference_id,
      })

      if (!userId) {
        throw new Error("userId is required to create notification")
      }

      const { data, error } = await supabase
        .from("notifications")
        .insert([
          {
            user_id: userId,
            title,
            message,
            type,
            read: false,
            reference_id: options?.reference_id,
            action_url: options?.action_url,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ])
        .select()

      if (error) {
        console.error("[NOTIFICATION-SERVICE] ❌ Insert error:", {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        })
        throw error
      }

      console.log("[NOTIFICATION-SERVICE] ✓ Notification created:", {
        id: data?.[0]?.id,
        user_id: data?.[0]?.user_id,
      })

      return data?.[0]
    } catch (error) {
      console.error("[NOTIFICATION-SERVICE] Failed to create notification:", error)
      throw error
    }
  },

  // Get unread notifications for user
  async getUnreadNotifications(userId: string) {
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .eq("read", false)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) {
      console.error("[NOTIFICATION] Error fetching unread notifications:", error)
      return []
    }

    return data || []
  },

  // Get all notifications
  async getAllNotifications(userId: string, limit = 100) {
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) {
      console.error("[NOTIFICATION] Error fetching notifications:", error)
      return []
    }

    return data || []
  },

  // Mark notification as read
  async markAsRead(notificationId: string) {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true, updated_at: new Date().toISOString() })
      .eq("id", notificationId)

    if (error) {
      console.error("[NOTIFICATION] Error marking notification as read:", error)
      throw error
    }
  },

  // Mark all notifications as read
  async markAllAsRead(userId: string) {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("read", false)

    if (error) {
      console.error("[NOTIFICATION] Error marking all notifications as read:", error)
      throw error
    }
  },

  // Delete a notification
  async deleteNotification(notificationId: string) {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("id", notificationId)

    if (error) {
      console.error("[NOTIFICATION] Error deleting notification:", error)
      throw error
    }
  },

  // Subscribe to real-time notifications
  subscribeToNotifications(userId: string, callback: (notification: Notification) => void) {
    const subscription = supabase
      .channel(`notifications:user_${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload: any) => {
          callback(payload.new as Notification)
        }
      )
      .subscribe()

    return subscription
  },

  // Get notification count
  async getUnreadCount(userId: string) {
    const { count, error } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("read", false)

    if (error) {
      console.error("[NOTIFICATION] Error getting notification count:", error)
      return 0
    }

    return count || 0
  },
}

// Notification template helpers for admin actions
export const notificationTemplates = {
  orderCompleted: (orderId: string, customerName: string) => ({
    title: "Order Completed",
    message: `Your order #${orderId} has been completed and is ready for delivery.`,
    type: "order_update" as NotificationType,
    reference_id: orderId,
  }),

  complaintResolved: (complaintId: string, resolution: string) => ({
    title: "Complaint Resolved",
    message: `Your complaint has been resolved. ${resolution}`,
    type: "complaint_resolved" as NotificationType,
    reference_id: complaintId,
  }),

  paymentSuccess: (amount: number, orderId: string) => ({
    title: "Payment Successful",
    message: `Payment of GHS ${amount.toFixed(2)} has been successfully processed.`,
    type: "payment_success" as NotificationType,
    reference_id: orderId,
  }),

  withdrawalApproved: (amount: number, withdrawalId: string) => ({
    title: "Withdrawal Approved",
    message: `Your withdrawal request for GHS ${amount.toFixed(2)} has been approved.`,
    type: "withdrawal_approved" as NotificationType,
    reference_id: withdrawalId,
  }),

  withdrawalRejected: (withdrawalId: string, reason: string) => ({
    title: "Withdrawal Rejected",
    message: `Your withdrawal request has been rejected. Reason: ${reason}`,
    type: "withdrawal_rejected" as NotificationType,
    reference_id: withdrawalId,
  }),

  balanceUpdated: (newBalance: number) => ({
    title: "Balance Updated",
    message: `Your wallet balance has been updated to GHS ${newBalance.toFixed(2)}.`,
    type: "balance_updated" as NotificationType,
  }),

  shopApproved: (shopName: string, shopId: string) => ({
    title: "Shop Approved",
    message: `Congratulations! Your shop "${shopName}" has been approved and is now active.`,
    type: "admin_action" as NotificationType,
    reference_id: shopId,
  }),

  shopRejected: (shopName: string, shopId: string, reason?: string) => ({
    title: "Shop Rejected",
    message: `Your shop "${shopName}" has been rejected. ${reason ? `Reason: ${reason}` : "Please contact support for more information."}`,
    type: "admin_action" as NotificationType,
    reference_id: shopId,
  }),
}

