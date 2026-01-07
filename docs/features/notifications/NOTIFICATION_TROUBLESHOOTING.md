# Notification System Troubleshooting Guide

## Issue: Users not receiving notifications

### Root Causes to Check:

#### 1. **Notifications Table Not Created**

The SQL migration must be run in Supabase to create the `notifications` table.

**Solution:**
- Go to Supabase Dashboard → SQL Editor
- Copy entire SQL from `migrations/create_notifications_table.sql`
- Execute the SQL

**Verify:**
- Open Supabase Dashboard
- Go to Database → Tables
- You should see `notifications` table listed
- Check RLS policies are enabled

#### 2. **Auth Context Issue**

The NotificationCenter component requires `useAuth()` hook which might not be providing the user correctly.

**Check:**
```typescript
// In browser console:
// Open any dashboard page and check:
const user = useAuth()
console.log("Current user:", user)
// Should show user object with user.id
```

#### 3. **Notification Service Errors**

The service might be silently failing.

**Solution: Add debugging**
```typescript
// In notification-service.ts, update createNotification:
async createNotification(...) {
  try {
    console.log("[NOTIFICATION] Creating notification for user:", userId)
    const { data, error } = await supabase.from("notifications").insert([...])
    
    if (error) {
      console.error("[NOTIFICATION] Supabase error:", error)
      throw error
    }
    
    console.log("[NOTIFICATION] ✓ Notification created:", data?.[0]?.id)
    return data?.[0]
  } catch (error) {
    console.error("[NOTIFICATION] Error creating notification:", error)
    throw error
  }
}
```

#### 4. **Supabase Connection Issues**

- Check network tab in browser DevTools
- Look for failed API calls to Supabase
- Check Supabase service is running

#### 5. **RLS Policy Issue**

The service role can't insert if RLS policies are misconfigured.

**Fix:** Run this SQL:

```sql
-- Drop existing policies and recreate
DROP POLICY IF EXISTS "Service role can insert notifications" ON notifications;

CREATE POLICY "Anyone can insert notifications" ON notifications
  FOR INSERT
  WITH CHECK (true);
```

### Quick Debug Checklist:

- [ ] **Table exists** - `SELECT * FROM notifications LIMIT 1`
- [ ] **RLS enabled** - `ALTER TABLE notifications ENABLE ROW LEVEL SECURITY`
- [ ] **Policies set** - `SELECT * FROM pg_policies WHERE tablename = 'notifications'`
- [ ] **User logged in** - Check `auth.uid()` is not null
- [ ] **Service role key** - Verify `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`
- [ ] **Real-time enabled** - Check Supabase settings

### Testing Notifications Manually:

1. **Test via Supabase UI:**
```sql
-- Insert notification directly
INSERT INTO notifications (user_id, title, message, type, read)
VALUES (
  'YOUR_USER_ID',  -- Replace with actual user UUID
  'Test Notification',
  'This is a test notification',
  'order_update',
  false
);
```

2. **Test via API:**
```bash
curl -X POST http://localhost:3000/api/notifications \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "title": "Test",
    "message": "Test notification",
    "type": "order_update"
  }'
```

3. **Test in browser console:**
```javascript
// First, get the token
const { data: { session } } = await supabase.auth.getSession()
const token = session?.access_token

// Create notification
const response = await fetch('/api/notifications', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    title: 'Test',
    message: 'Test from console',
    type: 'order_update'
  })
})

console.log('Response:', await response.json())
```

### Enable Debug Logging:

Update `lib/notification-service.ts` to add more logging:

```typescript
export const notificationService = {
  async createNotification(userId, title, message, type, options) {
    console.log('[NOTIFICATION-SERVICE] Creating notification:', {
      userId,
      title,
      message,
      type,
      options
    })

    if (!userId) {
      console.error('[NOTIFICATION-SERVICE] No userId provided!')
      return null
    }

    const { data, error } = await supabase
      .from("notifications")
      .insert([...])
      .select()

    if (error) {
      console.error('[NOTIFICATION-SERVICE] Insert error:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      })
      throw error
    }

    console.log('[NOTIFICATION-SERVICE] ✓ Created:', data?.[0]?.id)
    return data?.[0]
  }
}
```

### Check Supabase Logs:

1. Go to Supabase Dashboard
2. Navigate to Database → Query Performance
3. Look for errors related to `notifications` table
4. Check Function Logs if using edge functions

### Common Errors & Fixes:

**Error: "relation 'notifications' does not exist"**
- Solution: Run the SQL migration in Supabase

**Error: "Permission denied for schema public"**
- Solution: Check RLS policies are correct

**Error: "new row violates row-level security policy"**
- Solution: Check user_id matches auth.uid()

**Error: "duplicate key value violates unique constraint"**
- Solution: Notification already exists (idempotency issue)

### If Still Not Working:

1. **Check Supabase Status Page**
   - https://status.supabase.com

2. **Verify ENV Variables**
   ```bash
   # In .env.local
   echo $NEXT_PUBLIC_SUPABASE_URL
   echo $NEXT_PUBLIC_SUPABASE_ANON_KEY
   echo $SUPABASE_SERVICE_ROLE_KEY
   ```

3. **Test Supabase Connection**
   ```typescript
   // In browser console
   const { data, error } = await supabase.from('notifications').select('*').limit(1)
   console.log(data, error)
   ```

4. **Check RLS Policy Syntax**
   - Run in Supabase SQL Editor
   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'notifications';
   ```

5. **Verify Service Role Key is Set**
   - Check `.env.local` has `SUPABASE_SERVICE_ROLE_KEY`
   - Not using anon key for server-side operations

### Next Steps if Issue Persists:

1. Check `/api/webhooks/paystack` logs for error when notifications are called
2. Add try-catch around notification calls in complaint resolution
3. Verify table structure matches schema
4. Check Supabase network activity in DevTools
5. Enable query logging in Supabase settings

