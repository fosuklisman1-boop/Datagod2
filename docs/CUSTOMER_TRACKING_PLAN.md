# Customer Tracking Feature - Implementation Plan

## Overview
Track customers who make purchases through a shop owner's slug, enabling repeat customer identification, LTV calculation, and customer analytics visible on the shop dashboard.

---

## 1. DATABASE SCHEMA

### New Table: `shop_customers`
```sql
CREATE TABLE shop_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  customer_name VARCHAR(255),
  
  -- Tracking
  first_purchase_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_purchase_at TIMESTAMP NOT NULL DEFAULT NOW(),
  total_purchases INTEGER DEFAULT 1,
  total_spent DECIMAL(12,2) DEFAULT 0,
  repeat_customer BOOLEAN DEFAULT FALSE,
  
  -- Analytics
  first_source_slug VARCHAR(255),
  preferred_network VARCHAR(50),
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Constraints
  UNIQUE(shop_id, phone_number)
);

-- Indexes for performance
CREATE INDEX idx_shop_customers_shop_id ON shop_customers(shop_id);
CREATE INDEX idx_shop_customers_repeat_customer ON shop_customers(repeat_customer);
CREATE INDEX idx_shop_customers_last_purchase_at ON shop_customers(last_purchase_at DESC);
```

### New Table: `customer_tracking`
```sql
CREATE TABLE customer_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_order_id UUID NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  shop_customer_id UUID NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  
  -- Tracking
  accessed_via_slug VARCHAR(255),
  accessed_at TIMESTAMP DEFAULT NOW(),
  purchase_completed BOOLEAN DEFAULT FALSE,
  
  -- Optional: UTM Parameters
  referrer VARCHAR(255),
  utm_source VARCHAR(255),
  utm_medium VARCHAR(255),
  utm_campaign VARCHAR(255),
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_customer_tracking_shop_id ON customer_tracking(shop_id);
CREATE INDEX idx_customer_tracking_customer_id ON customer_tracking(shop_customer_id);
CREATE INDEX idx_customer_tracking_slug ON customer_tracking(accessed_via_slug);
CREATE INDEX idx_customer_tracking_accessed_at ON customer_tracking(accessed_at DESC);
```

### Modify: `shop_orders` Table
```sql
-- Add column to link orders to customers
ALTER TABLE shop_orders
ADD COLUMN IF NOT EXISTS shop_customer_id UUID REFERENCES shop_customers(id) ON DELETE SET NULL;

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_shop_orders_customer_id ON shop_orders(shop_customer_id);
```

---

## 2. IMPLEMENTATION PHASES

### Phase 1: Database Setup
- [ ] Create migration file: `migrations/add_customer_tracking_tables.sql`
- [ ] Add `shop_customer_id` to `shop_orders` table
- [ ] Create all indexes for performance
- [ ] Enable RLS policies on new tables

**Files to create:**
- `migrations/add_customer_tracking_tables.sql`

---

### Phase 2: Checkout Integration
- [ ] Modify order creation to track customers
- [ ] Update `app/api/admin/orders/create-shop-order` route to:
  - Check if customer exists (phone + shop_id)
  - Create new or update existing `shop_customers` record
  - Link order to customer via `shop_customer_id`
  - Create `customer_tracking` record
  - Update customer stats (total_spent, last_purchase_at, repeat_customer)

**Files to modify:**
- `app/api/admin/orders/create-shop-order/route.ts`

**Files to create:**
- `lib/customer-tracking-service.ts` (business logic)

---

### Phase 3: Shop Dashboard Integration
- [ ] Add customer metrics to shop dashboard
- [ ] Display on `app/admin/shop-dashboard/page.tsx`:
  - **Total Customers**: Unique customers who purchased
  - **Repeat Customers**: Customers with 2+ purchases
  - **New Customers (This Month)**: Customers with first purchase this month
  - **Average LTV**: Average lifetime value per customer
  - **Total Revenue**: Sum of all customer purchases

**Display format:**
```
┌─────────────────────────────────────────┐
│ Customer Overview                       │
├─────────────────────────────────────────┤
│ Total Customers: 45                     │
│ Repeat Customers: 12 (26.7%)            │
│ New This Month: 8                       │
│ Average LTV: GHS 125.50                 │
│ Total Revenue: GHS 5,647.50             │
└─────────────────────────────────────────┘
```

**Files to modify:**
- `app/admin/shop-dashboard/page.tsx`
- `app/api/admin/shops/[shopId]/route.ts` (add customer stats endpoint)

---

### Phase 4: Dedicated Customers Page
- [ ] Create `/admin/customers` page
- [ ] Display customer list with:
  - Customer name and phone
  - Email
  - Total purchases (with repeat indicator)
  - Total spent (LTV)
  - First purchase date
  - Last purchase date
  - Preferred network
  - Purchase history (expandable)

**Files to create:**
- `app/admin/customers/page.tsx`

**Files to modify:**
- `lib/customer-tracking-service.ts` (add list/detail functions)

---

### Phase 5: Customer Analytics API
- [ ] Create API endpoints:
  - `GET /api/admin/customers/list` - List customers with stats
  - `GET /api/admin/customers/[customerId]/history` - Purchase history
  - `GET /api/admin/customers/analytics` - Overall shop metrics
  - `GET /api/admin/customers/slug-analytics` - Slug performance

**Files to create:**
- `app/api/admin/customers/list/route.ts`
- `app/api/admin/customers/[customerId]/history/route.ts`
- `app/api/admin/customers/analytics/route.ts`
- `app/api/admin/customers/slug-analytics/route.ts`

---

### Phase 6: Optional - Loyalty Features
- [ ] Repeat customer badges/status
- [ ] Loyalty discount codes for repeat customers
- [ ] Customer referral tracking
- [ ] Seasonal customer analysis

**Files to consider:**
- `lib/loyalty-service.ts`
- `app/api/admin/customers/loyalty/route.ts`

---

## 3. DATA FLOW

```
1. Customer visits /shop/[slug]
   ├─ Store slug in session/URL

2. Customer enters checkout
   ├─ Phone, Email, Name captured

3. Payment successful
   ├─ Create shop_orders record
   ├─ Check: Does shop_customer exist? (phone + shop_id)
   │  ├─ YES → Update existing record
   │  │  ├─ Increment total_purchases
   │  │  ├─ Update last_purchase_at
   │  │  ├─ Add to total_spent
   │  │  ├─ Set repeat_customer = true
   │  └─ NO → Create new shop_customers record
   │     ├─ Set first_purchase_at = now()
   │     ├─ Set total_purchases = 1
   │     ├─ Set total_spent = order.total_price
   │     ├─ Set first_source_slug = [slug]
   │
   ├─ Link order to customer: shop_order.shop_customer_id = shop_customer.id
   │
   ├─ Create customer_tracking record
   │  ├─ shop_order_id = order.id
   │  ├─ shop_customer_id = customer.id
   │  ├─ accessed_via_slug = [slug]
   │  ├─ accessed_at = now()
   │  ├─ purchase_completed = true

4. Dashboard shows updated metrics
   ├─ Total customers
   ├─ Repeat customer count
   ├─ New customers this month
   ├─ Average LTV
```

---

## 4. KEY METRICS

### Dashboard Metrics (for shop owners)
| Metric | Calculation | Purpose |
|--------|------------|---------|
| **Total Customers** | COUNT(shop_customers WHERE shop_id = X) | Know customer base size |
| **Repeat Customers** | COUNT(shop_customers WHERE repeat_customer = true) | Understand loyalty |
| **Repeat %** | (Repeat / Total) * 100 | Track engagement |
| **New Customers** | COUNT(shop_customers WHERE DATE(first_purchase_at) >= DATE(NOW() - INTERVAL '30 days')) | Track growth |
| **Average LTV** | AVG(total_spent) | Understand value |
| **Total Revenue** | SUM(total_spent) | Business metric |

### Detailed Analytics (if needed)
| Metric | Calculation | Purpose |
|--------|------------|---------|
| **Slug Performance** | Orders per slug + conversion | Best performing slug |
| **Network Preference** | Most purchased network by customers | Inventory optimization |
| **Purchase Frequency** | Orders per customer | Engagement level |
| **Last Purchase Decay** | Days since last purchase | Churn risk |

---

## 5. DATABASE MIGRATION

Create: `migrations/add_customer_tracking_tables.sql`

```sql
-- Create shop_customers table
CREATE TABLE IF NOT EXISTS shop_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  customer_name VARCHAR(255),
  first_purchase_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_purchase_at TIMESTAMP NOT NULL DEFAULT NOW(),
  total_purchases INTEGER DEFAULT 1,
  total_spent DECIMAL(12,2) DEFAULT 0,
  repeat_customer BOOLEAN DEFAULT FALSE,
  first_source_slug VARCHAR(255),
  preferred_network VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id, phone_number)
);

-- Create customer_tracking table
CREATE TABLE IF NOT EXISTS customer_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_order_id UUID NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  shop_customer_id UUID NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  accessed_via_slug VARCHAR(255),
  accessed_at TIMESTAMP DEFAULT NOW(),
  purchase_completed BOOLEAN DEFAULT FALSE,
  referrer VARCHAR(255),
  utm_source VARCHAR(255),
  utm_medium VARCHAR(255),
  utm_campaign VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add shop_customer_id to shop_orders
ALTER TABLE shop_orders
ADD COLUMN IF NOT EXISTS shop_customer_id UUID REFERENCES shop_customers(id) ON DELETE SET NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_shop_customers_shop_id ON shop_customers(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_customers_repeat_customer ON shop_customers(repeat_customer);
CREATE INDEX IF NOT EXISTS idx_shop_customers_last_purchase_at ON shop_customers(last_purchase_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_tracking_shop_id ON customer_tracking(shop_id);
CREATE INDEX IF NOT EXISTS idx_customer_tracking_customer_id ON customer_tracking(shop_customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_tracking_slug ON customer_tracking(accessed_via_slug);
CREATE INDEX IF NOT EXISTS idx_customer_tracking_accessed_at ON customer_tracking(accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_orders_customer_id ON shop_orders(shop_customer_id);

-- Enable RLS
ALTER TABLE shop_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_tracking ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Shop owners can view their customers"
  ON shop_customers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops
      WHERE user_shops.id = shop_customers.shop_id
      AND user_shops.user_id = auth.uid()
    )
  );

CREATE POLICY "Shop owners can view their customer tracking"
  ON customer_tracking FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops
      WHERE user_shops.id = customer_tracking.shop_id
      AND user_shops.user_id = auth.uid()
    )
  );
```

---

## 6. IMPLEMENTATION CHECKLIST

### Database
- [ ] Create migration file
- [ ] Run migration in Supabase
- [ ] Verify tables exist
- [ ] Verify indexes created
- [ ] Test RLS policies

### Order Creation Integration
- [ ] Create `lib/customer-tracking-service.ts`
- [ ] Modify `/api/admin/orders/create-shop-order/route.ts`
- [ ] Test customer creation on first order
- [ ] Test customer update on repeat order
- [ ] Test customer_tracking record creation

### Shop Dashboard
- [ ] Fetch customer stats in dashboard
- [ ] Display metrics cards
- [ ] Format numbers (decimals, percentages)
- [ ] Handle zero customers gracefully
- [ ] Test responsive layout

### Customers Page
- [ ] Create customers list page
- [ ] Add API endpoint for customer list
- [ ] Implement search/filter
- [ ] Show purchase history
- [ ] Add pagination if needed

### Testing
- [ ] Test with wallet payment
- [ ] Test with Paystack payment
- [ ] Test repeat customer flow
- [ ] Test dashboard metrics calculation
- [ ] Verify data integrity

---

## 7. FILE STRUCTURE

```
migrations/
├── add_customer_tracking_tables.sql

app/
├── api/
│   └── admin/
│       ├── customers/
│       │   ├── list/route.ts
│       │   ├── analytics/route.ts
│       │   ├── slug-analytics/route.ts
│       │   └── [customerId]/
│       │       └── history/route.ts
│       └── orders/
│           └── create-shop-order/route.ts (modified)
├── admin/
│   ├── customers/
│   │   └── page.tsx
│   └── shop-dashboard/
│       └── page.tsx (modified)

lib/
├── customer-tracking-service.ts (new)
└── shop-service.ts (may need modification)
```

---

## 8. PRIORITY ORDER

1. **HIGH**: Phase 1 (Database) + Phase 2 (Checkout Integration)
   - Core functionality, enables tracking
   
2. **HIGH**: Phase 3 (Dashboard Integration)
   - Visibility for shop owners
   
3. **MEDIUM**: Phase 4 (Dedicated Page)
   - Detailed customer insights
   
4. **MEDIUM**: Phase 5 (Analytics API)
   - Extensibility for future features
   
5. **LOW**: Phase 6 (Loyalty Features)
   - Enhancement for retention

---

## 9. NOTES

- Phone number (not email) is unique key per shop since that's how customers are identified during checkout
- Existing orders won't have `shop_customer_id` set until they're processed
- Migration should be backward compatible
- Consider implementing a backfill job for existing orders if needed
- Performance: Indexes on shop_id and repeat_customer for fast dashboard queries

