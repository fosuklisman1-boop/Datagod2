# Storefront Payment Flow - After Paystack Confirmation

## Current Flow After Storefront Purchase

### Step 1: Customer Places Order
1. Customer fills checkout form (name, email, phone)
2. Clicks "Place Order" button
3. Shop order is created with:
   - `payment_status = "pending"`
   - `order_status = "pending"`
   - Reference code generated
4. Paystack payment initialized with shop order details

### Step 2: Customer Redirected to Paystack
- Customer redirected to Paystack payment gateway
- Can pay with: Card, Mobile Money, Bank Transfer
- Paystack returns customer after payment (success/failure)

### Step 3: Paystack Callback & Payment Verification
**Current Redirect URL**: `/dashboard/wallet?payment_status=completed`
⚠️ **ISSUE**: This is wrong for shop orders! Customer gets redirected to wallet page instead of order confirmation

**What Should Happen**:
1. Paystack redirects to payment verification endpoint
2. System verifies payment with Paystack API
3. Updates shop order: `payment_status = "completed"`
4. Redirects to shop order confirmation page (not wallet page)

### Step 4: Payment Verification Process
When payment verified successfully:
```typescript
✓ Payment verification calls /api/payments/verify
✓ Fetches payment record from wallet_payments table
✓ If shopId exists: Updates shop_orders payment_status to "completed"
✓ Returns success response
```

### Step 5: Order Confirmation Page Display
Customer sees:
- ✅ Order reference number (can copy)
- ✅ Order status badge (pending/processing/completed)
- ✅ Payment status badge (completed/pending/failed)
- ✅ Package details (network, volume)
- ✅ Pricing breakdown (base price, service fee, total)
- ✅ Delivery information (customer name, phone, email)
- ✅ Next steps instructions
- ✅ Continue Shopping button
- ✅ Support contact info

### Step 6: What Happens After Order Confirmation
**Current Status**: Order awaits admin processing
- Order stored in `shop_orders` table with `payment_status="completed"`
- Order status remains `"pending"` (waiting for admin)
- Admin can see order in `/api/admin/shop-orders/pending` endpoint
- Admin downloads order batch for processing
- Order status changes to `"processing"` after download
- Customer's network is delivered (implementation specific to network provider)

## Current Issues to Fix

### 1. **Wrong Redirect URL After Paystack**
- **Current**: Redirects to `/dashboard/wallet?payment_status=completed`
- **Should Be**: Redirect to shop order confirmation page
- **Why**: Customer never sees order confirmation for shop orders

### 2. **No Polling/Real-time Payment Status**
- Order confirmation page doesn't poll for payment completion
- Payment status badge always shows what was in DB at page load
- Should refresh to show completed payment status after Paystack redirect

### 3. **Missing Order Delivery Tracking**
- No mechanism to notify customers when order is processed
- No status update notifications
- No way for customer to track processing status

### 4. **No Email Notifications**
- No confirmation email sent to customer after order creation
- No payment success email
- No order processing/delivery email

## Recommended Improvements

### A. Fix Payment Redirect Flow
```typescript
// In /api/payments/initialize/route.ts
// For shop orders, redirect back to order confirmation:
const redirectUrl = shopId 
  ? `${request.headers.get("origin")}/shop/${shopSlug}/order-confirmation/${orderId}`
  : `${request.headers.get("origin")}/dashboard/wallet?payment_status=completed`
```

### B. Add Payment Status Polling
```typescript
// In order-confirmation/[orderId]/page.tsx
// Poll /api/orders/status endpoint every 3 seconds
// Update payment_status badge in real-time
```

### C. Send Confirmation Emails
```typescript
// After order creation:
- Send order confirmation to customer
- Send payment instructions

// After payment verification:
- Send payment success email
- Include order reference and next steps

// After admin processing:
- Send order processing email
- Include delivery details
```

### D. Add Order Status Tracking Page
```typescript
// New page: /shop/[slug]/order-status/[orderId]
// Shows:
- Order status timeline
- Current processing stage
- Estimated delivery time
- Support contact if issues
```

## Database State After Payment

### wallet_payments table
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "shop_id": "uuid",  // Links to shop
  "amount": 15.00,
  "reference": "WALLET-xxx-xxx",
  "status": "completed",  // ✅ Updated by verification
  "payment_method": "paystack",
  "amount_received": 15.00,
  "created_at": "2025-11-27T10:00:00Z",
  "updated_at": "2025-11-27T10:05:00Z"
}
```

### shop_orders table
```json
{
  "id": "uuid",
  "shop_id": "uuid",  // Links to shop owner
  "customer_name": "John Doe",
  "customer_phone": "0201234567",
  "customer_email": "john@example.com",
  "network": "MTN",
  "volume_gb": 1,
  "base_price": 10.00,
  "profit_amount": 5.00,
  "total_price": 15.00,
  "order_status": "pending",  // Waiting for admin
  "payment_status": "completed",  // ✅ Updated by verification
  "reference_code": "ORD-xxx",
  "created_at": "2025-11-27T10:00:00Z",
  "updated_at": "2025-11-27T10:05:00Z"
}
```

## What Admin Sees

Admin views `/api/admin/shop-orders/pending` and sees:
```
✅ All paid shop orders (payment_status="completed", order_status="pending")
✅ Shop owner information
✅ Customer delivery phone number
✅ Package details (network, volume)
✅ Can download as Excel batch
✅ Can update status to "processing" → "completed"
```

## Timeline Summary

```
Customer Places Order
         ↓
Shop order created (payment_status="pending")
         ↓
Redirected to Paystack
         ↓
Customer completes payment
         ↓
Paystack confirms payment
         ↓
Redirected back to app
         ↓
❌ CURRENTLY: Goes to wallet page (WRONG)
✅ SHOULD: Goes to order confirmation
         ↓
Order confirmation page loads
         ↓
Shows: Reference #, Payment Status (pending → completed)
         ↓
Customer can view order details & delivery info
         ↓
Order appears for admin in shop-orders/pending
         ↓
Admin downloads & processes order
         ↓
Network provider delivers data to phone
         ↓
Customer receives data within 30 minutes
```

## Next Steps to Implement

1. **Fix redirect URL** - Send customer back to shop order confirmation, not wallet
2. **Add real-time status polling** - Order confirmation page auto-updates
3. **Send email notifications** - Confirmation, payment success, order processing
4. **Add order tracking** - Customers can check order status anytime
5. **Add customer notifications** - SMS/Email when order is processed
