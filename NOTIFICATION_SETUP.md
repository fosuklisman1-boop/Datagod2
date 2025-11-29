# Quick Setup Guide - Notifications

## Step 1: Execute Database Migration ⚠️ **REQUIRED**

The notifications table must exist in Supabase for the system to work.

### Method 1: Via Supabase Dashboard (Recommended)

1. Open [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Go to **SQL Editor** (left sidebar)
4. Click **New Query**
5. Copy the entire content of `migrations/create_notifications_table.sql`
6. Paste it into the SQL Editor
7. Click **Run**
8. Wait for success message ✓

### Method 2: Via Supabase CLI (If you have CLI setup)

```bash
supabase db push
```

## Step 2: Verify Table was Created

In Supabase SQL Editor, run:

```sql
-- Check if table exists
SELECT * FROM notifications LIMIT 1;

-- Check RLS policies
SELECT * FROM pg_policies WHERE tablename = 'notifications';

-- Check indexes
SELECT * FROM pg_indexes WHERE tablename = 'notifications';
```

You should see:
- ✓ Table created (no error from SELECT)
- ✓ 4 RLS policies listed
- ✓ 3 indexes listed

## Step 3: Test Notifications are Working

### Method 1: In Browser Console

1. Go to http://localhost:3000/dashboard
2. Open Developer Tools (F12)
3. Go to Console tab
4. Run this:

```javascript
// Test the notification API endpoint
const response = await fetch('/api/test/notifications', {
  headers: {
    'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session.access_token}`
  }
})
const result = await response.json()
console.log(result)
```

Expected output:
```javascript
{
  status: "SUCCESS",
  message: "All notification tests passed ✓",
  recentNotifications: [
    {
      id: "...",
      title: "Test Notification",
      message: "...",
      read: false
    }
  ]
}
```

### Method 2: Via curl

```bash
curl http://localhost:3000/api/test/notifications
```

### Method 3: Manual SQL Test

In Supabase SQL Editor:

```sql
-- Insert a test notification
INSERT INTO notifications (user_id, title, message, type)
VALUES (
  'YOUR_USER_UUID',  -- Replace with your user ID
  'Manual Test',
  'Testing manually created notification',
  'order_update'
);

-- Verify it was created
SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5;
```

## Step 4: Test Admin Action Creates Notification

1. **Admin Tab:** Go to http://localhost:3000/admin/complaints
2. **User Tab:** Go to http://localhost:3000/dashboard/notifications (open in new tab)
3. **Admin:** Resolve a complaint by:
   - Finding a complaint
   - Adding resolution notes
   - Clicking "Resolve Complaint"
4. **Check Browser Console:** Should see:
   ```
   [NOTIFICATION] Complaint resolution notification sent to user {userId}
   ```
5. **User Tab:** Bell icon should show unread count, dropdown should show notification

## Troubleshooting

### Issue: "Notifications table does not exist"

**Solution:** Run the SQL migration (Step 1)

### Issue: No notifications appear after admin action

**Check:**
1. Open browser console (F12)
2. Look for errors starting with `[NOTIFICATION]`
3. Common error messages:
   - `"relation 'notifications' does not exist"` → Run migration
   - `"Permission denied"` → RLS policy issue
   - `"new row violates RLS policy"` → userId mismatch

### Issue: Bell icon shows 0 unread, but notification center is empty

**Debug:**
```javascript
// In browser console
const { data: { user } } = await supabase.auth.getUser()
const { data: notifications } = await supabase
  .from('notifications')
  .select('*')
  .eq('user_id', user.id)
  
console.log('Your notifications:', notifications)
```

### Issue: Notification appears but doesn't disappear after marking as read

This is UI sync issue. Refresh the page or wait a few seconds for real-time sync.

## Verification Checklist

After completing all steps, verify:

- [ ] `notifications` table exists in Supabase
- [ ] RLS policies are enabled and created
- [ ] Test notification API returns SUCCESS
- [ ] Manual complaint resolution creates notification
- [ ] Notification appears in bell icon dropdown
- [ ] Notification appears on `/dashboard/notifications` page
- [ ] Clicking "Mark as Read" works
- [ ] Real-time updates work (no need to refresh)

## What's Working

✅ Notification service layer (`lib/notification-service.ts`)
✅ UI components (NotificationCenter, Dashboard page)
✅ Integration with complaint resolution
✅ Real-time subscriptions
✅ Error logging and debugging

## What Happens Now

1. When admin resolves complaint → `handleResolve()` called
2. Complaint updated in database → Success
3. `notificationService.createNotification()` called with:
   - User ID from complaint
   - Title: "Complaint Resolved"
   - Message: Resolution notes
   - Type: "complaint_resolved"
4. Notification inserted into database
5. Real-time subscription triggers
6. Bell icon updates with unread count
7. User sees notification in dropdown

## Next Steps (After Verification)

Once notifications are working, add them to:

1. **Order Status Changes** - `app/api/admin/orders/bulk-update-status`
2. **Withdrawal Approvals** - `app/admin/withdrawals` page
3. **Payment Success** - `app/api/webhooks/paystack`
4. **Balance Updates** - `app/api/admin/users` route

See `NOTIFICATION_TEMPLATES.md` for code examples.

---

**Questions?** Check `NOTIFICATION_TROUBLESHOOTING.md` for detailed debugging guide.
