# Debug Customer Tracking Issues

## 🚨 Critical Step - Apply RLS Policies

**Have you run the SQL from `apply_rls_policies.sql` in your Supabase dashboard?**

This is REQUIRED before inserts will work. Without these policies, the database blocks INSERT operations.

### Steps:
1. Go to your Supabase dashboard
2. Click **SQL Editor**
3. Copy and paste the content from `apply_rls_policies.sql`
4. Click **Run**

If you skip this step, bulk order customer tracking **WILL NOT WORK**.

---

## 🔍 Diagnostic Steps

### 1. Check if policies exist
In Supabase SQL Editor, run:
```sql
SELECT * FROM pg_policies WHERE tablename = 'shop_customers';
```

Expected result: Should show 4 policies:
- "Shop owners can view their customers"
- "System can insert shop customers"
- "System can update shop customers"
- Plus a DELETE policy if you have one

### 2. Test direct insert
```sql
INSERT INTO shop_customers (
  shop_id,
  phone_number,
  customer_name,
  email,
  first_source_slug,
  total_spent
) VALUES (
  'YOUR_SHOP_ID_HERE',
  '0551234567',
  'Test Customer',
  'test@example.com',
  'test',
  10.50
) RETURNING id;
```

If this fails, the RLS policies are blocking you.

### 3. Check RLS is enabled
```sql
SELECT relname, relrowsecurity 
FROM pg_class 
WHERE relname = 'shop_customers';
```

Should show: `shop_customers | t` (true = RLS enabled)

### 4. Check if you have the right shop_id
Get your shop ID:
```sql
SELECT id, user_id, shop_name 
FROM user_shops 
WHERE user_id = 'YOUR_USER_ID_HERE';
```

Replace `YOUR_USER_ID_HERE` with your actual user ID from auth.users.

---

## 📋 Checklist

- [ ] RLS policies applied from `apply_rls_policies.sql`
- [ ] Verified policies exist with step 1
- [ ] Confirmed your shop_id exists
- [ ] Test direct insert works (step 2)
- [ ] Create bulk order and check server logs

---

## 🐛 Server Logs to Check

When you create a bulk order, check your API logs for these messages:

```
[BULK-ORDERS] Found shop [SHOP_ID], tracking [N] bulk order customers...
[CUSTOMER-TRACKING] Tracking customer: [PHONE] for shop [SHOP_ID]
[CUSTOMER-TRACKING] Insert payload: {...}
[CUSTOMER-TRACKING] ✓ New customer created: [CUSTOMER_ID]
```

If you see `✗ INSERT FAILED:` followed by an error, RLS policies are likely the issue.

---

## ⚠️ Common Issues

| Issue | Solution |
|-------|----------|
| Insert fails with "permission denied" | Apply RLS policies from `apply_rls_policies.sql` |
| No shop found | Verify user has a shop in `user_shops` table |
| Shop ID is NULL | Create a shop first in dashboard |
| Inserts work but customer not visible | Check customer filtering - might be filtering by `first_source_slug` |

