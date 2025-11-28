# Multi-Step Checkout - Quick Start

## ⚡ 60-Second Overview

You now have a complete 5-step checkout system with:
- ✅ Network selection
- ✅ Package selection  
- ✅ Customer form with validation
- ✅ Order review
- ✅ Payment confirmation
- ✅ Error recovery
- ✅ Draft persistence
- ✅ Progress tracking

## 🚀 Getting Started

### 1. Enable the Checkout in Your App

Wrap your app with the OrderProvider in `app/layout.tsx`:

```tsx
import { OrderProvider } from '@/contexts/OrderContext'

export default function RootLayout({ children }) {
  return (
    <OrderProvider>
      {children}
    </OrderProvider>
  )
}
```

### 2. Link to Checkout from Shop Page

In your shop page (`app/shop/[slug]/page.tsx`), add:

```tsx
<Button onClick={() => router.push(`/shop/${slug}/checkout`)}>
  Go to Checkout
</Button>
```

### 3. Access Checkout

Navigate to:
```
http://localhost:3000/shop/[shop-slug]/checkout
```

---

## 📋 What Each Component Does

### Step 1: Network Selection (`step-selector.tsx`)
```
User selects network (MTN, Vodafone, Airtel, AT)
→ Network saved to context
→ Progress: 25%
```

### Step 2: Package Selection (`step-package.tsx`)
```
User selects data/airtime package
→ Package saved to localStorage draft
→ Draft auto-saved
→ Progress: 50%
```

### Step 3: Customer Details (`step-customer.tsx`)
```
User enters: name, email, phone
→ Real-time validation
→ Error messages shown
→ Progress: 50% (unchanged)
```

### Step 4: Review (`step-review.tsx`)
```
Shows order summary
→ Network, package, price
→ Customer details (masked)
→ "Confirm & Pay" button
```

### Step 5: Confirmation (`step-confirmation.tsx`)
```
Order created successfully!
→ Shows order ID
→ "Proceed to Payment" redirects to payment page
→ Progress: 100%
```

---

## 🎯 State Machine Overview

```
User starts → Selects Network (25%)
           ↓
          Selects Package (50%)
           ↓
          Enters Details
           ↓
          Review Order
           ↓
          Confirm & Create Order
           ↓
          Order Created! (100%)
           ↓
          Proceed to Payment
```

---

## 💾 Draft Auto-Save

The system automatically saves incomplete orders to localStorage:

```
When: User selects a package
Saved to: localStorage['order_draft']
Format: JSON with network, package, customer data
Expires: 24 hours
```

**Checking draft in browser console:**
```javascript
JSON.parse(localStorage.getItem('order_draft'))
```

---

## 🛡️ Validation

### Phone Number
- Must be 10 digits
- Must start with 0
- Must have 2 or 5 as 3rd digit (02x or 05x)
- Examples: `0241234567`, `0551234567` ✓

### Email
- Must be valid email format
- Example: `user@example.com` ✓

### Name
- Must be 2+ characters
- Example: `John Doe` ✓

---

## 🚨 Error Handling

If something goes wrong:

1. **Form Validation Error** → User sees error message → Can fix form
2. **Order Creation Error** → Shows recovery options:
   - Try Again
   - Fix Form
   - Start Over
   - Back to Shop

---

## 📊 Progress Tracking

Visual progress bar shows:
- Current step (1-5)
- Progress percentage (0-100%)
- Step name and description
- Checkmarks for completed steps

---

## 🔌 API Endpoints Required

Your backend needs these endpoints:

### 1. Get Shop Data
```
GET /api/shops/[slug]
Response: { id, name, networks[], packages[] }
```

### 2. Create Order
```
POST /api/shop-orders
Body: { networkId, packageId, customerData }
Response: { id, reference, created_at }
```

### 3. Get Payment Status (existing)
```
GET /api/payments/[orderId]
Response: { status, reference }
```

---

## 🧪 Test Flow

1. Navigate to `http://localhost:3000/shop/test-shop/checkout`
2. Select a network
3. Select a package
4. Enter details: Name, Email, Phone (0241234567)
5. Review order
6. Click "Confirm & Pay"
7. Should redirect to payment page

---

## 📁 File Locations

```
contexts/
  └── OrderContext.tsx .................. State machine

hooks/
  └── useOrderValidation.ts ............. Validation

components/checkout/
  ├── steps/
  │   ├── step-selector.tsx ............ Network
  │   ├── step-package.tsx ............ Package
  │   ├── step-customer.tsx ........... Form
  │   ├── step-review.tsx ............. Review
  │   └── step-confirmation.tsx ....... Success
  ├── progress-indicator.tsx .......... Progress bar
  └── error-recovery.tsx .............. Error UI

app/shop/[slug]/
  └── checkout/page.tsx ............... Main page
```

---

## ⚙️ Context API Quick Reference

```tsx
import { useOrderContext } from '@/contexts/OrderContext'

const {
  // Current state
  state,
  
  // Actions
  selectNetwork,        // (network) => void
  selectPackage,        // (pkg) => void
  updateCustomer,       // (field, value) => void
  submitOrder,          // (shopData) => void
  retryOrder,           // () => void
  editForm,             // () => void
  resetFlow,            // () => void
  setShop,              // (shop) => void
} = useOrderContext()
```

---

## 🎨 Customization

### Styling
All components use Tailwind CSS. Modify classes in component files.

### Validation Rules
Edit `hooks/useOrderValidation.ts` to change validation logic.

### Step Order
Edit `components/checkout/progress-indicator.tsx` to reorder steps.

### Messages
Search for strings in component files and update as needed.

---

## 📞 Troubleshooting

**Q: Checkout page shows "Loading shop..."**  
A: Ensure `/api/shops/[slug]` endpoint exists and returns correct data

**Q: Form validation not working**  
A: Check that `useOrderValidation` hook is imported correctly

**Q: Order not being created**  
A: Verify `/api/shop-orders` endpoint exists and is accessible

**Q: Draft not saving**  
A: Check browser localStorage permissions

---

## ✅ Checklist

- [ ] OrderProvider added to app layout
- [ ] Checkout button added to shop page
- [ ] API endpoints verified
- [ ] Tested complete checkout flow
- [ ] Tested error recovery
- [ ] Tested on mobile
- [ ] Ready for production

---

## 🎓 Next Actions

1. Add OrderProvider to `app/layout.tsx`
2. Test checkout flow locally
3. Verify all API endpoints work
4. Test error scenarios
5. Deploy to production

---

**Ready to test? Navigate to `/shop/[slug]/checkout`**
