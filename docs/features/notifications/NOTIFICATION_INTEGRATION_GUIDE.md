# Notification Integration Guide

## How to Add Notifications to Other Admin Actions

Once the notifications table is set up and working, use these templates to add notifications to other admin actions.

## Template 1: Order Status Update

### Where: `app/api/admin/orders/bulk-update-status/route.ts`

```typescript
import { notificationService, notificationTemplates } from "@/lib/notification-service"

// In your status update handler, add this after successful update:
export async function POST(request: NextRequest) {
  // ... existing code ...

  try {
    // Update order status
    const updatedOrder = await updateOrderStatus(...)

    // Send notification to user
    if (updatedOrder) {
      const notificationData = {
        title: "Order Status Updated",
        message: `Your order status has been updated to: ${updatedOrder.status}`,
        type: "order_update",
        reference_id: updatedOrder.id,
        action_url: `/dashboard/my-orders?id=${updatedOrder.id}`
      }

      try {
        await notificationService.createNotification(
          updatedOrder.user_id,
          notificationData.title,
          notificationData.message,
          notificationData.type,
          {
            reference_id: notificationData.reference_id,
            action_url: notificationData.action_url
          }
        )
      } catch (notifError) {
        console.warn("[NOTIFICATION] Failed to send order update notification:", notifError)
        // Don't fail the order update if notification fails
      }
    }

    return NextResponse.json({ success: true, order: updatedOrder })
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
```

## Template 2: Payment Success Notification

### Where: `app/api/webhooks/paystack/route.ts`

```typescript
import { notificationService } from "@/lib/notification-service"

// After successful payment verification:
export async function POST(request: NextRequest) {
  // ... existing code ...

  if (event === "charge.success") {
    const order = await getOrder(reference)

    // Send payment success notification
    try {
      await notificationService.createNotification(
        order.user_id,
        "Payment Successful",
        `Payment of ₦${(event.amount / 100).toLocaleString()} received for your order.`,
        "payment_success",
        {
          reference_id: order.id,
          action_url: `/dashboard/transactions`
        }
      )
    } catch (notifError) {
      console.warn("[NOTIFICATION] Failed to send payment notification:", notifError)
    }
  }
}
```

## Template 3: Withdrawal Approved

### Where: `app/admin/withdrawals/page.tsx` or API route

```typescript
import { notificationService } from "@/lib/notification-service"

// After approving withdrawal:
async function handleApproveWithdrawal(withdrawalId: string) {
  try {
    const withdrawal = await approveWithdrawal(withdrawalId)

    // Send notification
    await notificationService.createNotification(
      withdrawal.user_id,
      "Withdrawal Approved",
      `Your withdrawal of ₦${withdrawal.amount.toLocaleString()} has been approved and is being processed.`,
      "withdrawal_approved",
      {
        reference_id: withdrawalId,
        action_url: `/dashboard/wallet`
      }
    ).catch(e => console.warn("[NOTIFICATION] Approval notification failed:", e))

    toast.success("Withdrawal approved")
  } catch (error) {
    toast.error("Failed to approve withdrawal")
  }
}
```

## Template 4: Withdrawal Rejected

```typescript
// After rejecting withdrawal:
async function handleRejectWithdrawal(withdrawalId: string, reason: string) {
  try {
    const withdrawal = await rejectWithdrawal(withdrawalId, reason)

    // Send notification
    await notificationService.createNotification(
      withdrawal.user_id,
      "Withdrawal Rejected",
      `Your withdrawal request has been rejected. Reason: ${reason}`,
      "withdrawal_rejected",
      {
        reference_id: withdrawalId,
        action_url: `/dashboard/wallet`
      }
    ).catch(e => console.warn("[NOTIFICATION] Rejection notification failed:", e))

    toast.success("Withdrawal rejected")
  } catch (error) {
    toast.error("Failed to reject withdrawal")
  }
}
```

## Template 5: Balance Updated

### Where: `app/api/admin/users/route.ts`

```typescript
import { notificationService } from "@/lib/notification-service"

// After updating user balance:
export async function PUT(request: NextRequest) {
  const { userId, balanceChange, reason } = await request.json()

  try {
    const user = await updateUserBalance(userId, balanceChange)

    // Send notification
    const action = balanceChange > 0 ? "credited" : "debited"
    const amount = Math.abs(balanceChange)

    await notificationService.createNotification(
      userId,
      "Balance Updated",
      `Your wallet has been ${action} with ₦${amount.toLocaleString()}. Reason: ${reason}`,
      "balance_updated",
      {
        reference_id: userId,
        action_url: `/dashboard/wallet`
      }
    ).catch(e => console.warn("[NOTIFICATION] Balance notification failed:", e))

    return NextResponse.json({ success: true, user })
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
```

## Template 6: New Package Published

### Where: Where you create/publish packages

```typescript
import { notificationService } from "@/lib/notification-service"

// After publishing new package:
async function publishPackage(packageData) {
  try {
    const newPackage = await createPackage(packageData)

    // Get all users to notify
    const users = await getAllUsers()

    // Send notification to each user
    for (const user of users) {
      await notificationService.createNotification(
        user.id,
        "New Package Available",
        `Check out our new data package: ${newPackage.name}`,
        "order_update",
        {
          reference_id: newPackage.id,
          action_url: `/shop/${newPackage.slug}`
        }
      ).catch(e => console.warn("[NOTIFICATION] Package notification failed:", e))
    }

    toast.success("Package published and users notified")
  } catch (error) {
    toast.error("Failed to publish package")
  }
}
```

## Best Practices

### 1. Always Wrap in Try-Catch

```typescript
// ❌ DON'T - This will break admin action if notification fails
await notificationService.createNotification(...)

// ✅ DO - Notification failures don't block main action
try {
  await notificationService.createNotification(...)
} catch (error) {
  console.warn("[NOTIFICATION] Failed to send:", error)
  // Continue without throwing
}
```

### 2. Use Appropriate Types

```typescript
// Notification types available:
type NotificationType = 
  | "order_update"           // Order status changes
  | "complaint_resolved"     // Complaint resolved
  | "payment_success"        // Payment completed
  | "withdrawal_approved"    // Withdrawal approved
  | "withdrawal_rejected"    // Withdrawal rejected
  | "balance_updated"        // Wallet balance changed
  | "admin_action"           // Generic admin action
```

### 3. Include Action URLs

Always provide `action_url` so users can navigate to relevant page:

```typescript
{
  reference_id: orderId,
  action_url: `/dashboard/my-orders?id=${orderId}`
}
```

### 4. Use User IDs Correctly

Ensure the user_id is the receiving user, not the admin:

```typescript
// ✅ Correct - notification goes to order owner
await notificationService.createNotification(
  order.user_id,  // Owner of the order
  "Order Updated",
  ...
)

// ❌ Wrong - notification goes to admin
await notificationService.createNotification(
  adminUserId,    // Wrong recipient
  ...
)
```

### 5. Test in Console

Before deploying, test in browser console:

```javascript
const { data: { session } } = await supabase.auth.getSession()
const response = await fetch('/api/test/notifications', {
  headers: {
    'Authorization': `Bearer ${session.access_token}`
  }
})
const result = await response.json()
console.log(result)
```

## Error Messages & Solutions

### "relation 'notifications' does not exist"
→ Run SQL migration from `migrations/create_notifications_table.sql`

### "new row violates row-level security policy"
→ Check user_id is valid and matches auth.users.id

### "Permission denied for schema public"
→ Verify RLS policies grant permissions to authenticated users

### No error but notification doesn't appear
→ Check browser console for `[NOTIFICATION]` logs
→ Verify subscription is connecting in NotificationCenter component

## Testing Checklist

For each admin action that sends notifications:

- [ ] Admin action completes successfully
- [ ] Check browser console for `[NOTIFICATION]` log
- [ ] User's notification bell shows unread count
- [ ] Notification appears in dropdown
- [ ] Clicking notification navigates to correct URL
- [ ] Marking as read works
- [ ] Real-time updates don't require page refresh

## Debugging

To debug notification issues:

1. **Enable Logging:**
   ```typescript
   // Already enabled in lib/notification-service.ts
   console.log("[NOTIFICATION-SERVICE] Creating notification:", ...)
   ```

2. **Check Supabase Logs:**
   - Go to Supabase Dashboard
   - Database → Logs
   - Look for notifications table errors

3. **Check RLS Policies:**
   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'notifications';
   ```

4. **Test Direct Insert:**
   ```sql
   INSERT INTO notifications (user_id, title, message, type, read)
   VALUES ('your-user-id', 'Test', 'Test message', 'order_update', false);
   ```

## Common Patterns

### Bulk Notifications to Multiple Users

```typescript
// For broadcast notifications (new features, announcements, etc.)
async function notifyAllUsers(title: string, message: string) {
  const { data: users } = await supabase
    .from('auth.users')
    .select('id')

  for (const user of users) {
    await notificationService.createNotification(
      user.id,
      title,
      message,
      'admin_action'
    ).catch(e => console.warn("[NOTIFICATION] Broadcast failed for", user.id))
  }
}
```

### Conditional Notifications

```typescript
// Only notify if specific conditions met
if (order.status === 'completed' && order.total > 100000) {
  await notificationService.createNotification(
    order.user_id,
    "Large Order Completed",
    `Your order for ₦${order.total.toLocaleString()} has been completed!`,
    "order_update"
  ).catch(e => console.warn("[NOTIFICATION] Failed:", e))
}
```

---

**Need more help?** See `NOTIFICATION_TROUBLESHOOTING.md` for detailed debugging.
