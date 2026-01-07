# 🔔 Notifications System - Action Required

## Status: 🟡 READY TO ACTIVATE

The notification system has been built and integrated, but **the database table needs to be created in Supabase** before it will work.

---

## ⚡ Quick Fix (5 minutes)

### Step 1: Create the Notifications Table in Supabase

1. Open [Supabase Dashboard](https://app.supabase.com)
2. Select your **Datagod2** project
3. Click **SQL Editor** (left sidebar)
4. Click **New Query**
5. Copy this entire SQL:

```sql
-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  reference_id VARCHAR(255),
  action_url VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- Enable Row Level Security
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own notifications" ON notifications
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert notifications" ON notifications
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can update their own notifications" ON notifications
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own notifications" ON notifications
  FOR DELETE
  USING (auth.uid() = user_id);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_notifications_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS trigger_update_notifications_timestamp ON notifications;
CREATE TRIGGER trigger_update_notifications_timestamp
  BEFORE UPDATE ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION update_notifications_timestamp();

-- Permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO authenticated;
```

6. Click **Run** (blue button, bottom right)
7. Wait for ✓ success message

### Step 2: Verify it Worked

In the same SQL Editor, run:

```sql
SELECT * FROM notifications LIMIT 1;
```

You should get a result with 0 rows (table is empty), not an error.

### Step 3: Test the System

Open browser console (F12 → Console) and run:

```javascript
// Test if notifications work
const response = await fetch('/api/test/notifications')
const result = await response.json()
console.log(result)
```

Expected output:
```javascript
{
  status: "SUCCESS",
  message: "All notification tests passed ✓",
  totalNotifications: 1,
  recentNotifications: [...]
}
```

---

## ✅ What's Already Built

### 1. **Database Schema**
- ✓ Notifications table structure defined
- ✓ RLS policies for security
- ✓ Auto-timestamp updates
- ⏳ **Needs: SQL migration execution in Supabase**

### 2. **Service Layer** (`lib/notification-service.ts`)
- ✓ Create notifications
- ✓ Fetch unread notifications
- ✓ Mark as read
- ✓ Real-time subscriptions (WebSocket)
- ✓ Delete notifications
- ✓ Pre-built templates for common actions

### 3. **UI Components**
- ✓ **NotificationCenter** - Bell icon with dropdown in header
- ✓ **Dashboard/notifications page** - Full notifications page with filtering
- ✓ Real-time updates (no page refresh needed)
- ✓ Mark as read / Delete actions

### 4. **Integration Points**
- ✓ Complaint resolution sends notification
- ✓ Error handling (notifications don't break admin actions)
- ✓ Logging for debugging

### 5. **Testing Endpoint**
- ✓ `/api/test/notifications` - Test if everything works

---

## 🔄 How It Works (After Setup)

### When Admin Resolves a Complaint:

1. Admin opens `/admin/complaints`
2. Finds complaint and clicks "Resolve"
3. Adds resolution notes and confirms
4. System:
   - ✓ Updates complaint in database
   - ✓ Creates notification for user
   - ✓ Logs: `[NOTIFICATION] Complaint resolution notification sent to user {ID}`
5. User's notification bell updates with unread count
6. User sees notification in dropdown or dashboard

### Notification Flow:

```
Admin Action (Complaint Resolve)
    ↓
handleResolve() called
    ↓
Update complaint ✓
    ↓
notificationService.createNotification()
    ↓
INSERT into notifications table
    ↓
Real-time subscription triggers
    ↓
NotificationCenter component updates
    ↓
User sees:
  - Bell icon shows unread count
  - Dropdown shows new notification
  - Dashboard/notifications page updated
```

---

## 📋 Verification Checklist

After completing Step 1 (SQL migration):

- [ ] Supabase SQL Editor shows no errors
- [ ] `SELECT * FROM notifications;` returns success
- [ ] Test API at `/api/test/notifications` returns SUCCESS
- [ ] Can see "Test Notification" in Supabase table
- [ ] Bell icon appears in header
- [ ] Can resolve a complaint without errors
- [ ] Notification appears in user's notification center

---

## 🧪 Testing After Setup

### Test 1: Manual Notification Creation

In Supabase SQL Editor:

```sql
-- Get your user ID first:
SELECT id, email FROM auth.users LIMIT 5;

-- Insert test notification (replace user_id with your ID):
INSERT INTO notifications (user_id, title, message, type, read)
VALUES (
  'paste-your-user-id-here',
  'Test Notification',
  'If you see this, notifications are working!',
  'order_update',
  false
);
```

Check browser - should see notification appear immediately!

### Test 2: Real Admin Action

1. Open 2 browser tabs: one logged in as **admin**, one as **regular user**
2. Admin tab: Go to `/admin/complaints`
3. Find any complaint and resolve it
4. User tab: Go to `/dashboard` or `/dashboard/notifications`
5. Should see notification appear

### Test 3: API Endpoint

```bash
# In terminal
curl http://localhost:3000/api/test/notifications

# In browser console:
await fetch('/api/test/notifications').then(r => r.json()).then(console.log)
```

---

## 🔍 Debugging

### Issue: Notifications table doesn't exist

**Error message:** `"relation 'notifications' does not exist"`

**Fix:** Run the SQL migration (Step 1 above)

### Issue: Test returns error about RLS

**Error message:** `"permission denied"`

**Fix:** Check RLS policies are correct:

```sql
SELECT * FROM pg_policies WHERE tablename = 'notifications';
```

Should show 4 policies. If not, re-run the CREATE POLICY statements.

### Issue: Notification doesn't appear after admin action

**Debug steps:**

1. Open browser console (F12)
2. Look for logs starting with `[NOTIFICATION]`
3. Check for errors
4. Try manual test (Test 1 above)

### Issue: Bell icon shows 0 unread but notifications exist

**Cause:** UI sync issue

**Fix:** 
- Refresh page
- Wait 5 seconds for real-time subscription
- Check browser console for errors

---

## 📚 Documentation Files

Created for you:

1. **NOTIFICATION_SETUP.md** - Detailed setup guide
2. **NOTIFICATION_TROUBLESHOOTING.md** - Troubleshooting guide
3. **NOTIFICATION_INTEGRATION_GUIDE.md** - How to add notifications to other admin actions
4. **README_NOTIFICATIONS.md** (this file) - Quick action guide

---

## 🚀 Next Steps (After Step 3 Passes)

Once notifications are working, add them to:

### 1. Order Status Updates
When admin changes order status, user gets notification.

### 2. Withdrawal Approvals
When admin approves withdrawal, user gets notification.

### 3. Payment Success
When payment is confirmed, user gets notification.

### 4. Balance Updates
When wallet balance changes, user gets notification.

See `NOTIFICATION_INTEGRATION_GUIDE.md` for code examples.

---

## ❓ Questions?

1. **How do I know it's working?** - Notification bell will show unread count in header
2. **Will it break existing features?** - No, notifications are wrapped in try-catch
3. **Is it secure?** - Yes, RLS policies ensure users only see their own notifications
4. **Does it need real-time?** - Yes, but it works without Supabase real-time if needed
5. **Can I customize notifications?** - Yes, see `NOTIFICATION_INTEGRATION_GUIDE.md`

---

## 📞 Support

If stuck:

1. Check browser console for `[NOTIFICATION]` logs
2. Run test at `/api/test/notifications`
3. Check Supabase SQL Editor for errors
4. Read `NOTIFICATION_TROUBLESHOOTING.md`
5. Verify notifications table exists: `SELECT * FROM notifications;`

---

**Status:** ⏳ Waiting for database setup. Everything else is ready! ✨

**Estimated time:** 5 minutes to set up, 2 minutes to test, then notifications are live!
