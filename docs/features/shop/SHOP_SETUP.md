# Shop Feature - Setup Instructions

## 🚀 Quick Setup (10 minutes)

### Prerequisites
- Supabase account and project set up
- Datagod2 running locally or deployed
- Access to Supabase SQL editor

---

## Step 1: Create Database Tables (2 minutes)

### 1.1 Access Supabase SQL Editor
```
1. Go to https://app.supabase.com
2. Select your Datagod2 project
3. Left sidebar → SQL Editor
4. Click "+ New Query"
```

### 1.2 Copy Schema
```
1. Open lib/shop-schema.sql in your editor
2. Copy ALL content
3. Paste into Supabase SQL editor
4. Click "Run" button
5. Wait for green checkmark (should see "Success")
```

### 1.3 Verify Tables Created
```
Execute this query to verify:

SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE '%shop%'
ORDER BY table_name;

Expected output:
- shop_orders
- shop_packages  
- shop_profits
- shop_settings
- user_shops
- withdrawal_requests
```

---

## Step 2: Deploy Code (1 minute)

### Files Already Created ✓
All shop feature files have been created in your project:

```
NEW FILES:
✓ lib/shop-service.ts (shop business logic)
✓ lib/shop-schema.sql (database schema)
✓ app/dashboard/my-shop/page.tsx (shop management)
✓ app/dashboard/shop-dashboard/page.tsx (profit tracking)
✓ app/shop/[slug]/page.tsx (public storefront)
✓ app/shop/[slug]/order-confirmation/[orderId]/page.tsx
✓ SHOP_FEATURE_DOCS.md (documentation)
✓ SHOP_IMPLEMENTATION_GUIDE.md (this guide)

UPDATED FILES:
✓ components/layout/sidebar.tsx (added shop navigation)
```

### No Additional Setup Needed
The code is ready to use - just ensure your Next.js server is running:

```bash
npm run dev
```

---

## Step 3: Test the Feature (5 minutes)

### 3.1 Access Shop Management
```
1. Log into dashboard
2. Navigate to: Sidebar → SHOP → My Shop
3. You should see your shop dashboard
```

### 3.2 Add a Product
```
1. Click "Add Product" button
2. Select package: "MTN - 5GB" (GHS 19.50)
3. Enter profit margin: 2.50
4. See total price: GHS 22.00
5. Click "Add Product"
6. Product should appear in list
```

### 3.3 View Your Shop Link
```
1. Note the shop URL (e.g., /shop/shop-abc123)
2. Copy the URL
3. Open in new tab
4. You should see your public storefront
5. Verify products display correctly
```

### 3.4 Test Order Flow
```
1. On storefront, click "Buy Now" on a product
2. Checkout modal appears
3. Fill in test data:
   - Name: Test User
   - Email: test@example.com
   - Phone: 0201234567
4. Review order summary
5. Click "Place Order"
6. Should see confirmation page with order details
```

### 3.5 Check Shop Dashboard
```
1. Go to: Sidebar → SHOP → Shop Dashboard
2. View stats:
   - Available Balance
   - Total Profit
   - Total Orders
3. See your test order in "Recent Orders"
4. Profit from order should appear (when completed)
```

---

## Step 4: Customize Shop (Optional)

### 4.1 Edit Shop Details
```
1. Go to: Dashboard → My Shop
2. Click "Edit Shop"
3. Update:
   - Shop Name
   - Description
   - Logo URL (image link)
4. Click "Save Changes"
```

### 4.2 Manage Products
```
1. Add more packages with different profit margins
2. Toggle packages on/off with "Manage" button
3. Remove products as needed
```

### 4.3 View Profits
```
1. Go to: Dashboard → Shop Dashboard
2. Available Balance = sum of pending profits
3. Total Profit = all earned (pending + credited)
4. Click "Request Withdrawal" to cash out
```

---

## Step 5: Share Your Shop (Deployment)

### Share Your Shop URL
```
Your shop URL format: https://yourdomain.com/shop/your-shop-slug

Share with customers via:
- WhatsApp
- Facebook/Instagram
- Email
- Website
- Word of mouth
```

### Example URLs
```
Production: https://datagod.com/shop/my-shop
Staging: https://staging.datagod.com/shop/my-shop
Local: http://localhost:3000/shop/my-shop
```

---

## Troubleshooting

### Issue: "Tables not found"
**Solution:**
- Go to Supabase → Table Editor
- Check if shop tables exist
- If not, re-run shop-schema.sql
- Verify no SQL errors occurred

### Issue: Sidebar doesn't show shop items
**Solution:**
- Restart Next.js server: `Ctrl+C`, then `npm run dev`
- Clear browser cache
- Verify sidebar.tsx was updated

### Issue: "Cannot read property 'shop_id'"
**Solution:**
- Check if shop exists: Supabase → user_shops table
- Create shop if missing
- Ensure user_id is correct

### Issue: Phone validation failing
**Solution:**
- Format must be exactly 10 digits
- Must start with 0 (e.g., 0201234567)
- Not 9 digits (app auto-adds 0 prefix)

### Issue: Order not appearing in dashboard
**Solution:**
- Refresh page
- Check Supabase → shop_orders table for order
- Verify shop_id matches

---

## Environment Variables

No new environment variables required. The app uses existing:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

---

## Performance Tips

1. **Caching**: Shop data fetched fresh on each load (can optimize later)
2. **Images**: Use JPEG/PNG for logos and banners (< 1MB)
3. **Products**: Keep products < 50 items per shop for fast loading
4. **Mobile**: Storefront is fully responsive (tested on mobile)

---

## Security Checklist

- ✓ Row Level Security enabled on all tables
- ✓ Users can only manage their own shops
- ✓ Phone number validated on input
- ✓ Email validated on checkout
- ✓ Profit amounts cannot be manipulated
- ✓ Withdrawals require proper authorization

---

## API Documentation

Shop service functions available in `lib/shop-service.ts`:

```typescript
// Shop
shopService.getShop(userId)
shopService.getShopBySlug(slug)
shopService.updateShop(shopId, updates)

// Packages
shopPackageService.addPackageToShop(shopId, pkgId, margin)
shopPackageService.getShopPackages(shopId)

// Orders
shopOrderService.createShopOrder(data)
shopOrderService.getShopOrders(shopId)

// Profits
shopProfitService.getShopBalance(shopId)
shopProfitService.getTotalProfit(shopId)

// Withdrawals
withdrawalService.createWithdrawalRequest(userId, shopId, data)
withdrawalService.getWithdrawalRequests(userId)
```

---

## File Locations

```
Project Root/
├── app/
│   ├── dashboard/
│   │   ├── my-shop/
│   │   │   └── page.tsx ................. Shop management UI
│   │   └── shop-dashboard/
│   │       └── page.tsx ................. Profit tracking & withdrawals
│   └── shop/
│       ├── [slug]/
│       │   ├── page.tsx ................. Public storefront
│       │   └── order-confirmation/
│       │       └── [orderId]/page.tsx ... Order confirmation
├── components/
│   └── layout/
│       └── sidebar.tsx .................. Updated navigation
├── lib/
│   ├── shop-schema.sql .................. Database schema (run in Supabase)
│   ├── shop-service.ts .................. Business logic & API
│   └── database.ts ...................... Existing database service
├── SHOP_FEATURE_DOCS.md ................. Full documentation
└── SHOP_IMPLEMENTATION_GUIDE.md ......... This file
```

---

## Next Steps

### Immediate (Today)
- [ ] Run database schema in Supabase
- [ ] Test shop creation
- [ ] Test order flow
- [ ] Share shop link with friends

### Short Term (This Week)
- [ ] Customize your shop details
- [ ] Add multiple products with different margins
- [ ] Test withdrawal process

### Medium Term (This Month)
- [ ] Market your shop
- [ ] Get first real customers
- [ ] Request withdrawals
- [ ] Monitor performance

### Long Term (This Quarter)
- [ ] Optimize conversion rates
- [ ] Build customer base
- [ ] Scale to multiple shops (future feature)

---

## Support

### Documentation
- Full Docs: `SHOP_FEATURE_DOCS.md`
- Implementation: `SHOP_IMPLEMENTATION_GUIDE.md`
- API Reference: See above

### Getting Help
```
Email: support@datagod.com
WhatsApp: +233 XXX XXX XXXX
GitHub Issues: Submit issue with [SHOP] tag
```

### Reporting Issues
Include:
1. Error message (if any)
2. Steps to reproduce
3. Expected vs actual behavior
4. Screenshots (if helpful)

---

## Congratulations! 🎉

You now have a fully functional shop feature with:
✓ Shop management interface
✓ Public storefront with unique URL
✓ Order processing system
✓ Profit tracking & analytics
✓ Withdrawal request system
✓ Mobile responsive design
✓ Professional UI with modern styling

**Start selling data packages with custom margins today!**

---

**Version**: 1.0  
**Last Updated**: November 26, 2025  
**Status**: Production Ready ✓
