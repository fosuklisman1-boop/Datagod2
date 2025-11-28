# Multi-Step Checkout - Integration Steps (Complete)

## 📋 Step-by-Step Integration Guide

Follow these exact steps to integrate the multi-step checkout into your app.

---

## Step 1: Enable OrderProvider in App Layout

**File:** `app/layout.tsx`

**Current:**
```tsx
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html>
      <body>
        {children}
      </body>
    </html>
  )
}
```

**Updated:**
```tsx
import { OrderProvider } from '@/contexts/OrderContext'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html>
      <body>
        <OrderProvider>
          {children}
        </OrderProvider>
      </body>
    </html>
  )
}
```

**What it does:**
- Provides OrderContext to entire app
- Enables all checkout pages to use order state
- Persists order data across page navigations

---

## Step 2: Update Shop Page with Checkout Button

**File:** `app/shop/[slug]/page.tsx`

**Find this section (around line 150-200):**
```tsx
// Your existing checkout button or CTA section
<Button onClick={() => {
  // Handle order placement
}}>
  Place Order
</Button>
```

**Replace with:**
```tsx
'use client'

import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export default function ShopPage() {
  const router = useRouter()
  const params = useParams()
  const slug = params.slug as string

  const handleCheckout = () => {
    router.push(`/shop/${slug}/checkout`)
  }

  return (
    <div>
      {/* ... existing shop content ... */}
      
      <Button onClick={handleCheckout} size="lg">
        Proceed to Checkout
      </Button>
    </div>
  )
}
```

**What it does:**
- Adds navigation to new checkout page
- Passes shop slug as URL parameter
- Integrates with existing shop display

---

## Step 3: Verify API Endpoints

Your backend must have these 3 endpoints:

### 3.1 Get Shop Data

**Endpoint:** `GET /api/shops/[slug]`

**Request:**
```
GET /api/shops/test-shop
```

**Expected Response:**
```json
{
  "id": "shop_123",
  "name": "Test Shop",
  "slug": "test-shop",
  "networks": [
    {
      "id": "net_1",
      "name": "MTN",
      "slug": "mtn-ghana",
      "logo_url": "/logos/mtn.png",
      "description": "MTN Ghana"
    }
  ],
  "packages": [
    {
      "id": "pkg_1",
      "name": "1GB Bundle",
      "amount": 10.99,
      "package_type": "data",
      "network_id": "net_1",
      "validity_days": 30
    }
  ]
}
```

**Response Code:** 200 OK

---

### 3.2 Create Shop Order

**Endpoint:** `POST /api/shop-orders`

**Request:**
```json
{
  "networkId": "net_1",
  "packageId": "pkg_1",
  "customerData": {
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "0241234567"
  }
}
```

**Expected Response:**
```json
{
  "id": "order_12345",
  "reference": "ORD-20241215-12345",
  "created_at": "2024-12-15T10:30:00Z",
  "status": "pending"
}
```

**Response Code:** 201 Created

**Error Response (400):**
```json
{
  "error": "Invalid customer data",
  "message": "Phone number must be 10 digits"
}
```

---

### 3.3 Get Payment Status (Existing)

**Endpoint:** `GET /api/payments/[orderId]`

**Request:**
```
GET /api/payments/order_12345
```

**Expected Response:**
```json
{
  "id": "pay_123",
  "orderId": "order_12345",
  "reference": "PAY-20241215-123",
  "status": "completed",
  "amount": 10.99,
  "currency": "GHS"
}
```

---

## Step 4: Update Confirmation Page

Your confirmation page should handle the order ID from URL:

**File:** `app/shop/[slug]/confirmation/page.tsx`

Add this near the top of your component:
```tsx
'use client'

import { useSearchParams } from 'next/navigation'

export default function ConfirmationPage() {
  const searchParams = useSearchParams()
  const orderId = searchParams.get('orderId')

  // Use orderId to fetch payment status
  useEffect(() => {
    if (orderId) {
      fetchPaymentStatus(orderId)
    }
  }, [orderId])

  return (
    // Your existing confirmation UI
  )
}
```

---

## Step 5: Test the Complete Flow

### 5.1 Local Testing

1. **Start dev server:**
   ```bash
   npm run dev
   ```

2. **Navigate to shop:**
   ```
   http://localhost:3000/shop/test-shop
   ```

3. **Click checkout button:**
   - Should redirect to `/shop/test-shop/checkout`

4. **Go through steps:**
   - Step 1: Select network (25%)
   - Step 2: Select package (50%)
   - Step 3: Enter name, email, phone (50%)
   - Step 4: Review order
   - Step 5: Confirm and create order

5. **Verify order created:**
   - Should show order confirmation page
   - Should display order ID
   - Should show "Proceed to Payment" button

---

## Step 6: Handle Payment Redirect

After user clicks "Proceed to Payment" on confirmation page:

**File:** `app/shop/[slug]/confirmation/page.tsx`

```tsx
const handleProceedToPayment = async () => {
  // Get order from URL params
  const orderId = searchParams.get('orderId')
  
  // Fetch payment info
  const response = await fetch(`/api/payments/${orderId}`)
  const payment = await response.json()
  
  // Redirect to Paystack
  window.location.href = payment.authorization_url
}
```

---

## 📊 Data Flow Diagram

```
User navigates to shop
         ↓
Clicks "Proceed to Checkout"
         ↓
Redirects to /shop/[slug]/checkout
         ↓
Checkout page loads shop data (GET /api/shops/[slug])
         ↓
User selects network (25%)
         ↓
User selects package (50%)
         ↓
Draft auto-saved to localStorage
         ↓
User enters customer details
         ↓
User reviews order
         ↓
User confirms order
         ↓
OrderContext validates data
         ↓
POST to /api/shop-orders
         ↓
Order created with ID
         ↓
Redirect to confirmation page
         ↓
Show confirmation with order details
         ↓
User clicks "Proceed to Payment"
         ↓
Fetch payment info (GET /api/payments/[orderId])
         ↓
Redirect to Paystack payment gateway
         ↓
User completes payment
         ↓
Webhook updates order status
         ↓
User redirected to success page
```

---

## 🧪 Testing Checklist

### Pre-Integration Testing
- [ ] All new files compile without errors
- [ ] `npm run build` succeeds
- [ ] No TypeScript errors

### Integration Testing
- [ ] OrderProvider added to layout.tsx
- [ ] Checkout button added to shop page
- [ ] Can navigate to checkout page
- [ ] Shop data loads from API
- [ ] All API endpoints return correct data

### Flow Testing
- [ ] Can select network
- [ ] Can select package
- [ ] Draft saves to localStorage
- [ ] Can enter customer details
- [ ] Validation catches errors
- [ ] Can review order
- [ ] Can confirm and create order
- [ ] Order created response received
- [ ] Can redirect to confirmation
- [ ] Can see order details
- [ ] Can proceed to payment

### Error Testing
- [ ] Invalid customer data rejected
- [ ] API error handled gracefully
- [ ] Network error handled
- [ ] Recovery options appear
- [ ] Can retry failed actions
- [ ] Can start over

### Edge Cases
- [ ] Loading states work
- [ ] Disabled buttons work
- [ ] Mobile responsive
- [ ] Fast network (should work)
- [ ] Slow network (should work)
- [ ] Offline (should show error)

---

## 🚨 Common Issues & Solutions

### Issue: "ReferenceError: OrderProvider is not defined"
**Solution:** Make sure OrderProvider is imported in layout.tsx:
```tsx
import { OrderProvider } from '@/contexts/OrderContext'
```

### Issue: Checkout page shows "Loading shop..." indefinitely
**Solution:** Check that API endpoint `/api/shops/[slug]` exists and returns data:
```bash
curl http://localhost:3000/api/shops/test-shop
```

### Issue: Form validation not working
**Solution:** Verify useOrderValidation hook is imported:
```tsx
import { useOrderValidation } from '@/hooks/useOrderValidation'
```

### Issue: Order not being created
**Solution:** Check POST endpoint returns correct response:
```bash
curl -X POST http://localhost:3000/api/shop-orders \
  -H "Content-Type: application/json" \
  -d '{"networkId":"...", "packageId":"...", "customerData":{...}}'
```

### Issue: localStorage draft not saving
**Solution:** Check localStorage in browser DevTools:
```javascript
// In browser console:
localStorage.getItem('order_draft')
```

---

## ✅ Validation Rules Reference

These are automatically enforced by useOrderValidation hook:

```
Name:  2-100 characters, not empty
Email: Valid email format (xxx@xxx.xxx)
Phone: 10 digits, starts with 0, 3rd digit is 2 or 5
```

### Phone Examples
- ✅ 0241234567 (valid)
- ✅ 0551234567 (valid)
- ❌ 241234567 (invalid - no 0)
- ❌ 0161234567 (invalid - 3rd digit not 2 or 5)
- ❌ 024123456 (invalid - only 9 digits)

---

## 📁 Final File Structure

After integration, your structure should be:

```
app/
  ├── layout.tsx (MODIFIED - added OrderProvider)
  ├── shop/
  │   └── [slug]/
  │       ├── page.tsx (MODIFIED - added checkout button)
  │       ├── checkout/
  │       │   └── page.tsx (NEW)
  │       └── confirmation/
  │           └── page.tsx (existing)

contexts/
  └── OrderContext.tsx (NEW)

hooks/
  ├── useOrderValidation.ts (NEW)
  ├── useShopData.ts (existing)
  └── useShopOrder.ts (existing)

components/
  └── checkout/
      ├── progress-indicator.tsx (NEW)
      ├── error-recovery.tsx (NEW)
      └── steps/
          ├── step-selector.tsx (NEW)
          ├── step-package.tsx (NEW)
          ├── step-customer.tsx (NEW)
          ├── step-review.tsx (NEW)
          └── step-confirmation.tsx (NEW)
```

---

## 🎯 Integration Summary

**Files to modify:** 1
- `app/layout.tsx` - Add OrderProvider

**Files to create:** 0 (All new checkout files already exist)

**API endpoints required:** 3
- GET /api/shops/[slug]
- POST /api/shop-orders
- GET /api/payments/[orderId]

**Testing time:** ~30 minutes

**Deployment ready:** Yes ✅

---

## ✨ After Integration

Once integrated, users can:

1. ✅ Navigate to shop checkout
2. ✅ Select network and package
3. ✅ Enter customer details with validation
4. ✅ Review order summary
5. ✅ Create order with one click
6. ✅ See confirmation with order ID
7. ✅ Proceed to payment
8. ✅ Get recovery options if anything fails

---

**Need help? Check MULTISTEP_CHECKOUT_GUIDE.md for detailed documentation**
