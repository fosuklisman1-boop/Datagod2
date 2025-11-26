# Datagod2 Shop Feature Documentation

## Overview

The Shop feature enables users to:
1. **Create their own online store** to resell data packages
2. **Set custom profit margins** on packages
3. **Get a unique storefront URL** to share with customers
4. **Track orders and profits** in real-time
5. **Request withdrawals** of earned profits

## Architecture

### Database Schema

The shop system uses 6 new Supabase tables:

#### 1. `user_shops`
- Stores user shop information
- One shop per user (UNIQUE constraint)
- Fields: `shop_name`, `shop_slug`, `description`, `logo_url`, `banner_url`, `is_active`
- Public access: Can be viewed by slug when active

#### 2. `shop_packages`
- Maps packages to shops with profit margins
- Links original packages with custom pricing
- Fields: `shop_id`, `package_id`, `profit_margin`, `custom_name`, `is_available`

#### 3. `shop_orders`
- Customer purchase records from shops
- Tracks customer info, package details, and profit split
- Fields: `shop_id`, `customer_*`, `shop_package_id`, `network`, `volume_gb`, `base_price`, `profit_amount`, `total_price`, `order_status`, `payment_status`
- States: `pending` → `processing` → `completed`

#### 4. `shop_profits`
- Tracks profit accumulation from orders
- Separates pending and credited profits
- Fields: `shop_id`, `shop_order_id`, `profit_amount`, `status`

#### 5. `withdrawal_requests`
- User withdrawal requests for profits
- Stores account details (JSON)
- Fields: `shop_id`, `user_id`, `amount`, `withdrawal_method`, `account_details`, `status`
- States: `pending` → `approved` → `processing` → `completed`

#### 6. `shop_settings` (Optional)
- Shop-specific settings
- Fields: `commission_rate`, `auto_approve_orders`, `notification_email`

### Row Level Security (RLS)

- Users can only manage their own shops
- Public can view active shop packages
- Customers can create orders for any shop
- Shop owners see detailed analytics

## File Structure

```
lib/
├── shop-schema.sql          # Database schema (run in Supabase SQL editor)
├── shop-service.ts          # Business logic for all shop operations
│
app/
├── dashboard/
│   ├── my-shop/
│   │   └── page.tsx         # Shop management (add products, edit info)
│   └── shop-dashboard/
│       └── page.tsx         # Profit tracking & withdrawal requests
│
└── shop/
    ├── [slug]/
    │   ├── page.tsx         # Public storefront
    │   └── order-confirmation/
    │       └── [orderId]/
    │           └── page.tsx  # Order confirmation page
```

## Key Features

### 1. Shop Management (`/dashboard/my-shop`)

**Features:**
- View shop details (name, slug, logo)
- Generate unique shop link (copyable)
- Edit shop information
- Add packages with custom profit margins
- View all products in shop
- Toggle product availability
- Manage product pricing

**Tech Stack:**
- React hooks for state management
- Form validation for shop info
- Real-time package list updates

### 2. Public Storefront (`/shop/[slug]`)

**Features:**
- Browse all available packages by network
- View pricing breakdown (base + profit)
- One-click checkout modal
- Customer form validation
- Phone number validation (network-aware)
- Order summary before submission
- Responsive design

**Phone Validation:**
- Normalizes 9-digit to 10-digit numbers (adds 0 prefix)
- Validates format: starts with 02 or 05
- Validates length: exactly 10 digits

### 3. Shop Dashboard (`/dashboard/shop-dashboard`)

**Features:**
- Real-time profit tracking
- Available balance display
- Total profit (pending + credited)
- Order statistics
- Withdrawal request management
- Request/track withdrawals
- View withdrawal history

**Stats Cards:**
- Available Balance (pending profits)
- Total Profit (all time)
- Total Orders
- Pending Withdrawals

### 4. Withdrawal System

**Workflow:**
1. User requests withdrawal
2. System validates available balance
3. Withdrawal created with `pending` status
4. Admin reviews & approves
5. Status changes to `approved` → `processing` → `completed`
6. User receives payment

**Supported Methods:**
- Mobile Money (MTN, Telecel, AT)
- Bank Transfer

### 5. Order Management

**Order States:**
- `pending`: Order created, awaiting payment
- `processing`: Payment received, data being delivered
- `completed`: Data delivered successfully
- `failed`: Order failed, refund issued
- `refunded`: Money returned to customer

**Profit Flow:**
1. Customer places order → Order created with total_price
2. System splits: `base_price` to platform, `profit_amount` to shop owner
3. Profit record created with `pending` status
4. Shop owner sees profit in "Available Balance"
5. Shop owner requests withdrawal
6. After completion, profit status → `credited`

## Usage Guide

### For Shop Owners

#### Step 1: Set Up Shop
```
1. Go to Dashboard → My Shop
2. View your shop slug (e.g., /shop/shop-abc123)
3. Edit shop details (name, description, logo, banner)
4. Click "Save Changes"
```

#### Step 2: Add Products
```
1. Click "Add Product" button
2. Select a package from the list
3. Enter profit margin (e.g., GHS 2.50)
4. View calculated total price
5. Click "Add Product"
6. Product is now live in your store
```

#### Step 3: Share Store Link
```
1. Copy your shop URL from My Shop page
2. Share on social media, WhatsApp, email
3. Customers visit link and purchase directly
4. You get paid for each purchase
```

#### Step 4: Track Profits
```
1. Go to Dashboard → Shop Dashboard
2. View available balance and total profit
3. View all customer orders
4. See profit from each order
```

#### Step 5: Request Withdrawal
```
1. Click "Request Withdrawal" button
2. Enter amount (must be ≤ available balance)
3. Choose withdrawal method
4. Enter payment details (phone/bank)
5. Submit request
6. Wait for admin approval (1-2 business days)
7. Receive payment
```

### For Customers

#### Step 1: Browse Store
```
1. Visit shop URL (e.g., datagod.com/shop/my-awesome-shop)
2. Browse available data packages
3. See base price and service fee breakdown
4. View total price including service fee
```

#### Step 2: Purchase
```
1. Click "Buy Now" on desired package
2. Fill in checkout form:
   - Full Name
   - Email Address
   - Phone Number (10 digits, starts with 02 or 05)
3. Review order summary
4. Click "Place Order"
```

#### Step 3: Confirmation
```
1. See order confirmation page
2. Get reference code and receipt
3. Receive payment instructions via email
4. Complete payment
5. Receive data within 30 minutes
```

## API Reference

### Shop Service Functions

```typescript
// Shop Management
shopService.createShop(userId, shopData)
shopService.getShop(userId)
shopService.getShopBySlug(slug)
shopService.updateShop(shopId, updates)

// Shop Packages
shopPackageService.addPackageToShop(shopId, packageId, profitMargin)
shopPackageService.getShopPackages(shopId)
shopPackageService.updatePackageProfitMargin(shopPackageId, margin)
shopPackageService.togglePackageAvailability(shopPackageId, isAvailable)
shopPackageService.removePackageFromShop(shopPackageId)

// Shop Orders
shopOrderService.createShopOrder(orderData)
shopOrderService.getShopOrders(shopId, status?)
shopOrderService.updateOrderStatus(orderId, status)
shopOrderService.getOrderStatistics(shopId)

// Profits
shopProfitService.createProfitRecord(shopOrderId, shopId, amount)
shopProfitService.getShopBalance(shopId) // Pending only
shopProfitService.getTotalProfit(shopId) // Pending + credited
shopProfitService.getProfitHistory(shopId)

// Withdrawals
withdrawalService.createWithdrawalRequest(userId, shopId, data)
withdrawalService.getWithdrawalRequests(userId)
withdrawalService.updateWithdrawalStatus(withdrawalId, status)
```

## Profit Split Example

### Scenario
- Base Package Price: GHS 19.50 (MTN 5GB)
- Shop Owner's Profit Margin: GHS 2.50
- Customer Pays: GHS 22.00

### Distribution
- Platform Gets: GHS 19.50 (stored in system wallet)
- Shop Owner Gets: GHS 2.50 (stored in shop_profits)
- Customer Charged: GHS 22.00

### Withdrawal
- Shop owner requests withdrawal of GHS 50.00
- System sums all pending profits
- Creates withdrawal request
- Admin approves and processes
- Money sent to shop owner's account

## Security Features

1. **Row Level Security (RLS)**
   - Users can only view/edit their own shops
   - Users cannot modify other users' orders
   - Withdrawal requests are user-specific

2. **Validation**
   - Phone number format validation
   - Email validation
   - Profit margin validation (must be positive)
   - Withdrawal amount cannot exceed available balance

3. **Data Integrity**
   - Transaction logging for audit trail
   - Status tracking prevents unauthorized changes
   - Unique constraints on shop per user

4. **Rate Limiting** (Future)
   - Implement rate limiting on order creation
   - Prevent abuse of withdrawal system

## Future Enhancements

1. **Analytics Dashboard**
   - Sales charts and trends
   - Customer demographics
   - Top-performing products
   - Revenue forecasting

2. **Advanced Features**
   - Bulk package uploads
   - Discount codes for shops
   - Referral program
   - Shop ratings & reviews

3. **Payment Integration**
   - Direct payment processing
   - Multiple payment gateways
   - Automatic profit settlement

4. **Marketing Tools**
   - Shop customization (themes, colors)
   - SEO optimization
   - Social media integration
   - Email marketing

5. **Mobile App**
   - Native iOS/Android apps
   - Push notifications
   - Mobile order management

## Troubleshooting

### Common Issues

**Issue**: "Shop not found" error
- **Solution**: Ensure shop slug is correct, check if shop is active

**Issue**: Phone validation failing
- **Solution**: Format should be 10 digits starting with 02 or 05 (e.g., 0201234567)

**Issue**: Profit not showing in dashboard
- **Solution**: Profit appears after order is marked as completed

**Issue**: Can't request withdrawal
- **Solution**: Ensure available balance > 0 and > withdrawal amount

## Database Setup

To set up the shop feature:

1. Log into your Supabase dashboard
2. Go to SQL Editor
3. Create a new query
4. Copy the entire contents of `lib/shop-schema.sql`
5. Execute the query
6. Verify all tables are created

```sql
-- Verify tables were created
SELECT * FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE '%shop%';
```

## Performance Considerations

1. **Indexing**
   - Indexed shop_id on all related tables
   - Indexed status fields for faster filtering
   - Indexed slug for storefront lookups

2. **Caching** (Future)
   - Cache shop details for 5 minutes
   - Cache available packages per shop
   - Invalidate on updates

3. **Query Optimization**
   - Use SELECT with specific columns (not *)
   - Join packages to get full details
   - Use pagination for large order lists

## Compliance & Legal

1. **Terms of Service**
   - Shop owners agree to terms when creating shop
   - Profit splits are final and non-refundable
   - Platform reserves right to suspend shops

2. **Tax Considerations**
   - Shop owners responsible for tax obligations
   - Platform may issue 1099 forms
   - Withdrawals may be subject to fees

3. **Data Protection**
   - GDPR compliant data handling
   - Customer data encrypted in transit
   - No third-party sharing without consent

## Support

For issues or feature requests:
- Email: support@datagod.com
- WhatsApp: +233 XXX XXX XXXX
- Dashboard: Help & Support section

---

**Last Updated**: November 26, 2025
**Version**: 1.0
**Status**: Production Ready
