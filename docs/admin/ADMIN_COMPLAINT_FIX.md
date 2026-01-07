# Fix for Admin Complaint Update Issue

## Problem
Admin users cannot update complaint status in the database because the required RLS (Row Level Security) policies are missing from the `complaints` table.

## Solution
You need to add two RLS policies to the `complaints` table in Supabase to allow admins to read and update complaints.

### Step 1: Go to Supabase Dashboard
1. Visit https://app.supabase.com
2. Select your DATAGOD2 project
3. Click on "SQL Editor" in the left sidebar

### Step 2: Create Admin Read Policy
Copy and paste this SQL into the SQL Editor and click "Run":

```sql
CREATE POLICY "Admins can read all complaints" ON complaints
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );
```

### Step 3: Create Admin Update Policy
Copy and paste this SQL into the SQL Editor and click "Run":

```sql
CREATE POLICY "Admins can update all complaints" ON complaints
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );
```

### Step 4: Verify Policies
1. Go to "Authentication" → "Policies" in the left sidebar
2. Select the `complaints` table from the dropdown
3. You should see four policies:
   - ✅ Users can read their own complaints
   - ✅ Users can create complaints
   - ✅ Admins can read all complaints (NEW)
   - ✅ Admins can update all complaints (NEW)

### Step 5: Test
1. Refresh your browser
2. Go to `/admin/complaints`
3. Try to resolve a complaint
4. The status should now update successfully in the database

## What This Does
- **"Admins can read all complaints"**: Allows admin users to see all complaints from all customers (not just their own)
- **"Admins can update all complaints"**: Allows admin users to update complaint status and add resolution notes

## Security Note
These policies check if the current user has `role = 'admin'` in the `users` table before allowing access.
If you're not seeing the option to resolve complaints, make sure:
1. Your account has `role = 'admin'` in the `users` table
2. Both new policies have been successfully created

## Still Not Working?
1. Check browser console (F12) for error messages
2. Check the server terminal logs
3. Verify the admin policies appear in Supabase dashboard
4. Try logging out and logging back in
