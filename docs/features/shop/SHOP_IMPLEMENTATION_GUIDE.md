# Shop Feature Implementation Guide

## Quick Start (5 Minutes)

### Step 1: Deploy Database Schema

1. **Log into Supabase Dashboard**
   - Go to: https://app.supabase.com
   - Select your Datagod2 project

2. **Execute SQL Schema**
   - Navigate to: SQL Editor → New Query
   - Copy contents of `lib/shop-schema.sql`
   - Click "Run" button
   - Wait for completion (should see green checkmark)

3. **Verify Tables**
   ```sql
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public' AND table_name LIKE '%shop%'
   ORDER BY table_name;
   ```
   Expected results:
   - `shop_orders`
   - `shop_packages`
   - `shop_profits`
   - `shop_settings`
   - `user_shops`
   - `withdrawal_requests`

### Step 2: Deploy Code Changes

1. **Files Created:**
   ```
   lib/
   ├── shop-schema.sql          ✓ Database schema
   ├── shop-service.ts          ✓ Business logic
   
   app/
   ├── dashboard/
   │   ├── my-shop/
   │   │   └── page.tsx         ✓ Shop management
   │   └── shop-dashboard/
   │       └── page.tsx         ✓ Profit tracking
   ├── shop/
   │   ├── [slug]/page.tsx      ✓ Public storefront
   │   └── [slug]/order-confirmation/[orderId]/page.tsx ✓ Order confirmation
   
   components/
   └── layout/sidebar.tsx       ✓ Updated navigation
   
   SHOP_FEATURE_DOCS.md         ✓ Complete documentation
   ```

2. **Update Sidebar Navigation**
   - Shop section now appears in sidebar
   - Two new menu items:
     - "My Shop" (shop management)
     - "Shop Dashboard" (profit tracking)

### Step 3: Test the Feature

#### Create a Test Shop
1. Sign in to dashboard
2. Navigate to: Dashboard → My Shop
3. Click "Edit Shop"
4. Update shop name (e.g., "My Awesome Shop")
5. Save changes
6. Copy shop URL

#### Test Public Storefront
1. Open shop URL in new tab
2. Verify:
   - Shop name displays
   - Products listed with pricing
   - "Buy Now" buttons visible
   - Pricing breakdown correct (base + profit)

#### Test Order Creation
1. Click "Buy Now" on any package
2. Fill in checkout form:
   - Name: Test User
   - Email: test@example.com
   - Phone: 0201234567
3. Review order summary
4. Click "Place Order"
5. Verify order confirmation page

#### Test Shop Dashboard
1. Go to: Dashboard → Shop Dashboard
2. Verify stats cards display:
   - Available Balance: GHS 0 (no completed orders yet)
   - Total Profit: GHS 0
   - Total Orders: Should include test order
   - Pending Withdrawals: 0

## Architecture Overview

```
User Flow:
├── Shop Owner
│   ├── Creates shop (/dashboard/my-shop)
│   ├── Adds products (with profit margins)
│   ├── Gets unique URL (datagod.com/shop/my-slug)
│   ├── Shares with customers
│   └── Tracks profits (/dashboard/shop-dashboard)
│
├── Customer
│   ├── Visits shop URL
│   ├── Browses packages
│   ├── Places order (checkout modal)
│   ├── Receives confirmation
│   └── Completes payment
│
└── Profit Split
    ├── Customer Pays: GHS 22.00 (base + profit)
    ├── Platform Gets: GHS 19.50 (base price)
    ├── Shop Owner Gets: GHS 2.50 (profit margin)
    └── Available in Shop Dashboard for withdrawal
```

## Database Schema Details

### user_shops Table
```sql
CREATE TABLE user_shops (
  id UUID PRIMARY KEY,
  user_id UUID UNIQUE,              -- One shop per user
  shop_name VARCHAR(255),           -- "My Shop"
  shop_slug VARCHAR(255) UNIQUE,    -- "shop-abc123"
  description TEXT,                 -- "Welcome to..."
  logo_url VARCHAR(500),            -- Shop avatar
  banner_url VARCHAR(500),          -- Header image
  is_active BOOLEAN,                -- Active/Inactive
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

### shop_packages Table
```sql
CREATE TABLE shop_packages (
  id UUID PRIMARY KEY,
  shop_id UUID,                     -- Which shop
  package_id UUID,                  -- Original package
  profit_margin DECIMAL(10,2),      -- GHS 2.50
  custom_name VARCHAR(255),         -- Optional
  is_available BOOLEAN,             -- Listed/Unlisted
  created_at TIMESTAMP
);
```

### shop_orders Table
```sql
CREATE TABLE shop_orders (
  id UUID PRIMARY KEY,
  shop_id UUID,                     -- Which shop
  customer_name VARCHAR(255),       -- Order by
  customer_email VARCHAR(255),      -- Contact
  customer_phone VARCHAR(20),       -- Delivery
  shop_package_id UUID,             -- Which product
  package_id UUID,                  -- Original package
  network VARCHAR(50),              -- MTN, Telecel, etc
  volume_gb DECIMAL(10,2),          -- 5GB
  base_price DECIMAL(10,2),         -- GHS 19.50
  profit_amount DECIMAL(10,2),      -- GHS 2.50
  total_price DECIMAL(10,2),        -- GHS 22.00
  order_status VARCHAR(50),         -- pending, completed
  payment_status VARCHAR(50),       -- pending, completed
  reference_code VARCHAR(255),      -- ORD-123456
  created_at TIMESTAMP
);
```

### shop_profits Table
```sql
CREATE TABLE shop_profits (
  id UUID PRIMARY KEY,
  shop_id UUID,                     -- Which shop
  shop_order_id UUID,               -- From which order
  profit_amount DECIMAL(10,2),      -- GHS 2.50
  status VARCHAR(50),               -- pending, credited
  credited_at TIMESTAMP,            -- When withdrawn
  created_at TIMESTAMP
);
```

### withdrawal_requests Table
```sql
CREATE TABLE withdrawal_requests (
  id UUID PRIMARY KEY,
  shop_id UUID,                     -- Which shop
  user_id UUID,                     -- Which user
  amount DECIMAL(10,2),             -- GHS 50.00
  withdrawal_method VARCHAR(50),    -- mobile_money, bank_transfer
  account_details JSONB,            -- {phone: "0201234567"}
  status VARCHAR(50),               -- pending, approved, completed
  reference_code VARCHAR(255),      -- WD-123456
  created_at TIMESTAMP
);
```

## API Documentation

### Shop Service (lib/shop-service.ts)

#### Shop Operations
```typescript
// Create shop
const shop = await shopService.createShop(userId, {
  shop_name: "My Shop",
  shop_slug: "shop-abc123",
  description: "Welcome to my shop"
})

// Get user's shop
const shop = await shopService.getShop(userId)

// Get shop by slug (public)
const shop = await shopService.getShopBySlug("shop-abc123")

// Update shop
const updated = await shopService.updateShop(shopId, {
  shop_name: "New Name"
})
```

#### Package Operations
```typescript
// Add package to shop
const pkg = await shopPackageService.addPackageToShop(
  shopId,
  packageId,
  2.50  // profit margin
)

// Get shop packages
const packages = await shopPackageService.getShopPackages(shopId)

// Update profit margin
await shopPackageService.updatePackageProfitMargin(shopPackageId, 3.00)

// Toggle availability
await shopPackageService.togglePackageAvailability(shopPackageId, true)
```

#### Order Operations
```typescript
// Create order
const order = await shopOrderService.createShopOrder({
  shop_id: shopId,
  customer_name: "John Doe",
  customer_email: "john@example.com",
  customer_phone: "0201234567",
  shop_package_id: shopPackageId,
  package_id: packageId,
  network: "MTN",
  volume_gb: 5,
  base_price: 19.50,
  profit_amount: 2.50,
  total_price: 22.00
})

// Get orders
const orders = await shopOrderService.getShopOrders(shopId)

// Update status
await shopOrderService.updateOrderStatus(orderId, "completed")
```

#### Profit Operations
```typescript
// Get available balance (pending only)
const balance = await shopProfitService.getShopBalance(shopId)
// Returns: 50.00 (sum of pending profits)

// Get total profit
const total = await shopProfitService.getTotalProfit(shopId)
// Returns: 150.00 (pending + credited)

// Get profit history
const history = await shopProfitService.getProfitHistory(shopId)
// Returns: [{ profit_amount, shop_orders { customer_name, ... }, ... }]
```

#### Withdrawal Operations
```typescript
// Create withdrawal request
const wd = await withdrawalService.createWithdrawalRequest(
  userId,
  shopId,
  {
    amount: 50.00,
    withdrawal_method: "mobile_money",
    account_details: { phone: "0201234567" }
  }
)

// Get withdrawals
const withdrawals = await withdrawalService.getWithdrawalRequests(userId)

// Update status (admin only)
await withdrawalService.updateWithdrawalStatus(
  withdrawalId,
  "approved",
  { processed_at: new Date() }
)
```

## Component Architecture

### /dashboard/my-shop/page.tsx
```
Shop Management Page
├── Shop Info Card
│   ├── Logo preview
│   ├── Shop name & description
│   ├── Shop URL (copyable)
│   ├── Status badge
│   └── Edit button
├── Products Tab
│   ├── Add Product Form
│   └── Products List
│       └── Each product shows:
│           ├── Network & size
│           ├── Base price
│           ├── Your price (with profit)
│           ├── Your profit
│           └── Manage button
└── Orders Tab (placeholder)
```

### /shop/[slug]/page.tsx
```
Public Storefront
├── Shop Header
│   ├── Banner (if exists)
│   ├── Logo
│   ├── Shop name
│   └── Description
├── Products Grid
│   └── Each product card shows:
│       ├── Network badge
│       ├── Volume
│       ├── Price breakdown
│       ├── Total price
│       └── Buy Now button
└── Checkout Modal
    ├── Package details
    ├── Customer form
    │   ├── Name input
    │   ├── Email input
    │   └── Phone input
    ├── Price summary
    ├── Order summary
    └── Place Order button
```

### /dashboard/shop-dashboard/page.tsx
```
Shop Dashboard
├── Stats Cards
│   ├── Available Balance
│   ├── Total Profit
│   ├── Total Orders
│   └── Pending Withdrawals
├── Withdrawal Request Form
│   ├── Amount input
│   ├── Method select
│   ├── Account details
│   └── Submit button
├── Orders Tab
│   └── Recent orders table
│       ├── Customer name
│       ├── Package details
│       ├── Your profit
│       ├── Status badge
│       └── Date
└── Withdrawals Tab
    └── Withdrawals history
        ├── Amount
        ├── Method
        ├── Status
        └── Date
```

## Testing Checklist

- [ ] Database tables created successfully
- [ ] Shop creation works
- [ ] Can add packages with profit margins
- [ ] Shop URL is unique and correct
- [ ] Public storefront accessible
- [ ] Product cards display correct prices
- [ ] Checkout form validates input
- [ ] Phone number validation works (02/05 format)
- [ ] Order confirmation page shows details
- [ ] Shop dashboard displays correct balance
- [ ] Can request withdrawal
- [ ] Sidebar navigation shows shop items

## Deployment Steps

### Development
```bash
# Test locally
npm run dev

# Visit http://localhost:3000
# Test all flows
```

### Staging
```bash
# Build
npm run build

# Start
npm run start

# Test in staging environment
```

### Production
```bash
# Merge to main branch
git checkout main
git merge develop

# Deploy (depending on your hosting)
# If using Vercel: Auto-deploys on merge
# If using other: Follow your deployment process
```

## Monitoring & Maintenance

### Daily Checks
- Monitor order creation success rate
- Check for failed withdrawals
- Review error logs

### Weekly Reviews
- Top-performing shops
- Total profit distributed
- Customer feedback

### Monthly Reports
- Revenue summary
- Shop growth metrics
- Payment processing status

## Rollback Plan

If issues occur:

```sql
-- Backup data first
SELECT * INTO shop_orders_backup FROM shop_orders;

-- Drop tables if needed
DROP TABLE IF EXISTS withdrawal_requests CASCADE;
DROP TABLE IF EXISTS shop_profits CASCADE;
DROP TABLE IF EXISTS shop_orders CASCADE;
DROP TABLE IF EXISTS shop_packages CASCADE;
DROP TABLE IF EXISTS shop_settings CASCADE;
DROP TABLE IF EXISTS user_shops CASCADE;

-- Then re-run schema
-- (see shop-schema.sql)
```

## FAQ

**Q: Can a user have multiple shops?**
A: No, currently one shop per user (enforced by UNIQUE constraint)

**Q: What happens if shop is deactivated?**
A: Shop becomes private, customers see 404, existing orders still tracked

**Q: Can profits be withdrawn before order completes?**
A: No, only pending profits can be withdrawn (auto-credited on order completion)

**Q: Is there a commission on profits?**
A: Not yet, but can be added in shop_settings.commission_rate

**Q: How long until withdrawal processes?**
A: 1-2 business days after admin approval

**Q: Can customers refund orders?**
A: Yes (via admin), profit status changes to refunded

## Support Resources

- **Docs**: `SHOP_FEATURE_DOCS.md`
- **Schema**: `lib/shop-schema.sql`
- **Services**: `lib/shop-service.ts`
- **Issues**: GitHub Issues or support@datagod.com

---

**Version**: 1.0
**Date**: November 26, 2025
**Status**: Ready for Deployment
