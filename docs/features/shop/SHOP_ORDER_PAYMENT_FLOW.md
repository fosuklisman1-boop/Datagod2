# Shop Order Payment & Admin Download Flow

## Overview
Shop orders placed through storefronts are now properly linked to shop owners and only appear for admin download after payment is confirmed.

## Key Features Implemented

### 1. Shop Order Linking
- All shop orders are created with a `shop_id` that links them to the shop owner
- Shop orders table: `shop_orders` (separate from regular bulk orders in `orders` table)
- Shop orders include profit margins and are tracked separately by shop

### 2. Payment Status Tracking
Each shop order has:
- `payment_status`: "pending" | "completed" | "failed"
- `order_status`: "pending" | "processing" | "completed" | "failed"

### 3. Payment Flow

#### Wallet Payment Flow (Immediate)
```
Customer makes purchase with wallet
    ↓
Shop order created with payment_status="pending"
    ↓
Wallet debit API called (/api/wallet/debit)
    ↓
If wallet payment succeeds:
  - Deduct from user wallet
  - Update shop order: payment_status="completed"
  - Order appears for admin download
```

#### Paystack Card Payment Flow (Async)
```
Customer makes purchase with card
    ↓
Shop order created with payment_status="pending"
    ↓
Paystack payment initialized
    ↓
Customer redirected to Paystack
    ↓
Payment verification called (/api/payments/verify)
    ↓
If Paystack verification succeeds:
  - Update wallet_payments status="completed"
  - Find shop order by reference code
  - Update shop order: payment_status="completed"
  - Order appears for admin download
```

### 4. Admin Only Sees Paid Orders

**New Endpoint**: `GET /api/admin/shop-orders/pending`
- Returns only shop orders where:
  - `order_status = "pending"` (not yet processed)
  - `payment_status = "completed"` (payment confirmed)
- Includes shop information (shop_name, shop_owner_id, shop_slug)
- Orders grouped by shop for owner visibility

**Separate Endpoint**: `GET /api/admin/orders/all-pending`
- Returns bulk orders from `orders` table (user's direct orders)
- These are NOT shop orders

## API Endpoints

### For Admin Download

**Get Shop Orders Ready for Processing**
```
GET /api/admin/shop-orders/pending

Response:
{
  success: true,
  data: [
    {
      id: "order-id",
      shop_id: "shop-id",
      shop_name: "Shop Name",
      shop_owner_id: "owner-id",
      shop_slug: "shop-slug",
      customer_name: "John Doe",
      phone_number: "0201234567",
      customer_email: "john@example.com",
      network: "MTN",
      size: 1,
      price: 15.00,
      base_price: 10.00,
      profit_amount: 5.00,
      status: "pending",
      payment_status: "completed",
      reference_code: "ORD-xxx",
      created_at: "2025-11-27T10:00:00Z",
      type: "shop"
    }
  ],
  count: 1
}
```

**Get Regular Bulk Orders**
```
GET /api/admin/orders/all-pending

Response:
{
  success: true,
  data: [
    {
      id: "order-id",
      phone_number: "0201234567",
      network: "MTN",
      size: "1GB",
      price: 4.80,
      status: "pending",
      created_at: "2025-11-27T10:00:00Z",
      type: "bulk"
    }
  ],
  count: 1
}
```

## Database Schema

### shop_orders Table Columns
- `id` (UUID, PK)
- `shop_id` (UUID, FK → shops) - **Links to shop owner**
- `customer_name` (text)
- `customer_phone` (text)
- `customer_email` (text)
- `network` (text)
- `volume_gb` (numeric)
- `base_price` (numeric)
- `profit_amount` (numeric) - profit for shop owner
- `total_price` (numeric) - base_price + profit_amount
- `order_status` (text) - "pending", "processing", "completed", "failed"
- `payment_status` (text) - **"pending", "completed", "failed"**
- `reference_code` (text) - unique reference for payments
- `created_at` (timestamp)
- `updated_at` (timestamp)

### Constraints
- Only orders with `payment_status = "completed"` are available for admin processing
- Orders belong to specific shops via `shop_id`
- Profit tracking enables shop owner earnings calculation

## Security & Validation

1. **Payment Status Check**: Orders must have confirmed payment before admin can download
2. **Shop Ownership**: Orders filtered by `shop_id` so owners only see their own orders
3. **Transaction Integrity**: Payment marked as completed only AFTER verification succeeds
4. **Wallet Consistency**: Wallet balance updated atomically with payment verification

## Testing Checklist

- [ ] Customer purchases through shop storefront with wallet payment
  - Verify: Order created with `payment_status="completed"`
  - Verify: Order appears in `/api/admin/shop-orders/pending`
  - Verify: Wallet balance deducted

- [ ] Customer purchases through shop storefront with card payment
  - Verify: Order created with `payment_status="pending"`
  - Verify: Order NOT in admin download until payment verified
  - Verify: After Paystack confirmation, order appears in admin download
  - Verify: Wallet credited after payment success

- [ ] Admin download functionality
  - Verify: Only sees paid shop orders (payment_status="completed")
  - Verify: Can download and process orders
  - Verify: Orders update to "processing" status after download

## Related Files

- `/app/api/payments/verify/route.ts` - Updates shop order payment status
- `/app/api/wallet/debit/route.ts` - Updates shop order payment status for wallet
- `/app/api/admin/shop-orders/pending/route.ts` - NEW: Returns paid shop orders
- `/app/api/admin/orders/all-pending/route.ts` - NEW: Returns bulk orders
- `/app/shop/[slug]/page.tsx` - Shop storefront order creation
- `/lib/shop-service.ts` - Shop order service functions

## Summary

✅ **Shop orders are now:**
1. Linked to shop owners via `shop_id`
2. Only downloadable by admin after payment is confirmed
3. Tracked separately from user bulk orders
4. Include profit margins for shop owners
5. Support both wallet and card payments

✅ **Payment verification:**
1. Automatically updates shop order payment status
2. Wallet payments: Immediate status update
3. Paystack payments: Async status update after verification

✅ **Admin visibility:**
1. Can only see orders with confirmed payment
2. Clear separation between bulk and shop orders
3. Can see shop owner information for each order
