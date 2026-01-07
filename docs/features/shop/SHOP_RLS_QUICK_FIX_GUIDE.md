# Quick RLS Policy Fix Implementation Guide

## 🎯 Objective
Fix "new row violates rls on user_shops table" error and complete RLS coverage on all 6 shop tables.

## ⏱️ Time Estimate
- **SQL Execution:** 2-3 minutes
- **Testing:** 5-10 minutes
- **Total:** 10-15 minutes

## 📋 Prerequisites

✅ Supabase project access  
✅ SQL editor access (or API key)  
✅ All shop tables created (user_shops, shop_packages, shop_orders, shop_profits, withdrawal_requests, shop_settings)

## 🚀 Implementation Steps

### Step 1: Access Supabase SQL Editor

1. Open [https://app.supabase.com](https://app.supabase.com)
2. Select your project
3. Go to **SQL Editor**
4. Click **New Query**

### Step 2: Copy Migration File

1. Open `migrations/0037_fix_shop_table_rls_policies.sql` in your editor
2. Copy ALL content (lines 1-211)

### Step 3: Execute Migration

1. Paste entire migration into Supabase SQL editor
2. Click **Run** button
3. Wait for execution to complete (~2 seconds)

**Expected output:**
```
✓ Query executed successfully
```

### Step 4: Verify All Policies Created

Run this verification query in SQL editor:

```sql
-- Verify all policies exist
SELECT 
  tablename,
  COUNT(*) as policy_count,
  STRING_AGG(policyname, ', ' ORDER BY policyname) as policies
FROM pg_policies
WHERE tablename IN (
  'user_shops',
  'shop_packages', 
  'shop_orders',
  'shop_profits',
  'withdrawal_requests',
  'shop_settings'
)
GROUP BY tablename
ORDER BY tablename;
```

**Expected results:**

| tablename | policy_count | policies |
|-----------|--------------|----------|
| shop_orders | 4 | Admins can..., Users can delete..., Users can insert..., Users can update... |
| shop_packages | 4 | Users can delete..., Users can insert..., Users can update..., Users can view... |
| shop_profits | 3 | System can update..., Users can insert..., Users can view... |
| shop_settings | 4 | Users can delete..., Users can insert..., Users can update..., Users can view... |
| user_shops | 4 | Users can create..., Users can delete..., Users can update..., Users can view... |
| withdrawal_requests | 3 | Admins can update..., Users can insert..., Users can view... |

**Total: 22 policies across 6 tables ✓**

### Step 5: Test Basic Operations

#### Test 1: Verify INSERT works with auth.uid() check

```sql
-- This will show if policies allow NULL auth
SELECT 
  tablename,
  policyname,
  with_check
FROM pg_policies
WHERE tablename = 'user_shops'
AND policyname = 'Users can create their own shop';
```

Expected: `with_check` should include `auth.uid() IS NOT NULL`

#### Test 2: Verify DELETE policies exist

```sql
SELECT 
  tablename,
  COUNT(*) as delete_policies
FROM pg_policies
WHERE tablename IN (
  'user_shops',
  'shop_packages',
  'shop_orders',
  'shop_settings'
)
AND policyname LIKE '%delete%'
GROUP BY tablename;
```

Expected: 4 tables with 1 DELETE policy each

#### Test 3: Verify SELECT allows public access

```sql
SELECT 
  tablename,
  policyname,
  qual
FROM pg_policies
WHERE tablename IN ('user_shops', 'shop_packages', 'shop_orders')
AND policyname LIKE '%view%'
AND qual LIKE '%is_active%';
```

Expected: Policies allowing public access to active shops

### Step 6: Test Application Flow

1. **Log out** of your app (or use incognito window)
2. **Create test shop account** or use existing
3. **Navigate to shop creation page**
4. **Submit shop creation form**
5. **Verify:**
   - ✅ No RLS error appears
   - ✅ Shop is created successfully
   - ✅ User is set as shop owner
   - ✅ Shop appears in user's dashboard

### Step 7: Run Automated Tests

```bash
# In your terminal:
cd path/to/project

# Run the RLS test script
npx ts-node scripts/test-shop-creation-rls.ts
```

Expected: All 5 tests pass ✅

## 🔍 Troubleshooting

### Issue: "New row violates rls" still occurs

**Solution:**
1. Clear browser cache (Ctrl+Shift+Del)
2. Clear local Supabase cache: `rm ~/.supabase`
3. Verify migration ran completely
4. Check that all DROP POLICY statements succeeded
5. Re-run migration (idempotent, safe to repeat)

### Issue: Policies don't appear in verification query

**Solution:**
1. Verify SQL executed without errors (check for error messages)
2. Check spelling of table names (case-sensitive in query)
3. Try running just the DROP statements first, then CREATE statements
4. Check Supabase logs for constraint errors

### Issue: "Permission denied" on DELETE operations

**Solution:**
1. Verify DELETE policy was created: `SELECT * FROM pg_policies WHERE policyname LIKE '%delete%'`
2. Check that `USING` clause is correct: `auth.uid() = user_id`
3. Ensure user_id is being set correctly in application
4. Test with admin/service_role account to verify table structure

### Issue: Unauthenticated users can't create orders

**Solution:**
1. Verify `shop_orders` INSERT policy has `WITH CHECK (true)`
2. Verify SELECT policy includes `OR auth.uid() IS NULL`
3. Check that frontend is not enforcing authentication on order creation
4. Test with anonymous key instead of authenticated key

## 📊 What Changed

### Before (Broken)
```sql
-- Missing DELETE policies
-- Missing auth.uid() IS NOT NULL checks
-- Duplicate/conflicting SELECT policies
-- No system access for profit updates
-- Shop creation blocked with RLS error
```

### After (Fixed)
```sql
-- Added DELETE policies to all 4 tables
-- Added auth.uid() IS NOT NULL to INSERT checks
-- Consolidated SELECT policies with proper logic
-- Added UPDATE policies for system operations
-- Shop creation works with proper RLS checks
```

## 📋 Checklist: Before Going to Production

- [ ] All 22 policies created (verification query ran successfully)
- [ ] DELETE policies exist on user_shops, shop_packages, shop_orders, shop_settings
- [ ] INSERT policies have `auth.uid() IS NOT NULL` check
- [ ] UPDATE policies created for shop_profits and withdrawal_requests
- [ ] SELECT policies allow public/unauthenticated access where needed
- [ ] Test shop creation works without RLS error
- [ ] Test shop deletion works
- [ ] Test package deletion works
- [ ] Test order creation (anonymous) works
- [ ] Test profit update (system) works
- [ ] Automated tests pass: `npx ts-node scripts/test-shop-creation-rls.ts`
- [ ] No errors in Supabase logs
- [ ] Rollback plan documented (git history available)

## 🔄 Rollback Plan

If you need to revert these changes:

```bash
# Option 1: Use git to view previous policies
git show HEAD~1:lib/shop-schema.sql

# Option 2: Drop all new policies (manual rollback)
-- Run this in Supabase SQL editor to remove all fixes:
DROP POLICY IF EXISTS "Users can delete their own shop" ON public.user_shops;
DROP POLICY IF EXISTS "Users can delete packages for their shops" ON public.shop_packages;
-- ... etc
```

## 📞 Support

If you encounter issues:

1. **Check logs:** Supabase → Database → Logs
2. **Review policies:** SQL Editor → `SELECT * FROM pg_policies WHERE tablename LIKE 'user_%'`
3. **Test connection:** Try simple SELECT on affected table
4. **Check RLS status:** Verify RLS is enabled: `ALTER TABLE [table] ENABLE ROW LEVEL SECURITY;`

## 🎉 Success Indicators

✅ **Migration executed** - No errors in SQL output  
✅ **Policies created** - Verification query shows 22 policies  
✅ **Shop creation works** - User can create shop without RLS error  
✅ **Tests pass** - `test-shop-creation-rls.ts` shows all green ✅  
✅ **Orders work** - Anonymous users can create orders  
✅ **Admin operations** - Profit and withdrawal updates succeed  

**Status: RLS policies fully operational** 🚀

---

**Last Updated:** January 2026  
**Migration File:** `migrations/0037_fix_shop_table_rls_policies.sql`  
**Documentation:** `SHOP_RLS_POLICY_FIXES.md`
