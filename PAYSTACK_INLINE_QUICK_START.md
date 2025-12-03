# Paystack Inline Payment - Quick Start Guide

## Setup in 3 Steps

### Step 1: Get Your Paystack Keys

1. Log in to [Paystack Dashboard](https://dashboard.paystack.com)
2. Go to **Settings** → **API Keys & Webhooks**
3. Copy your keys:
   - **Public Key** (starts with `pk_test_` or `pk_live_`)
   - **Secret Key** (starts with `sk_test_` or `sk_live_`)

### Step 2: Add Environment Variables

Add to your `.env.local` file:

```env
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_your_key_here
PAYSTACK_SECRET_KEY=sk_test_your_key_here
```

**Important**: 
- Use test keys for development (`pk_test_` and `sk_test_`)
- Use live keys for production (`pk_live_` and `sk_live_`)
- Never commit your `.env.local` file to git

### Step 3: Deploy to Vercel

Add environment variables in Vercel:

1. Go to your project on Vercel
2. Navigate to **Settings** → **Environment Variables**
3. Add both variables:
   - `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`
   - `PAYSTACK_SECRET_KEY`
4. Redeploy your application

## Testing

### Test the Payment Flow

1. **Create an Order**:
   - Go to your storefront: `http://localhost:3000/shop/your-shop-slug`
   - Select a data package
   - Fill in customer details
   - Submit order

2. **Proceed to Payment**:
   - You'll be redirected to order confirmation page
   - Click **"Proceed to Payment"** button
   - Paystack modal will open (no page redirect!)

3. **Complete Test Payment**:
   - Use Paystack test card:
     - Card: `4084 0840 8408 4081`
     - CVV: `408`
     - Expiry: Any future date (e.g., 12/25)
     - PIN: `0000`
     - OTP: `123456`

4. **Verify Success**:
   - You'll be redirected to order status page
   - Order status should show "Paid"
   - Check database to confirm payment record

## What's Different?

### Before (Redirect Payment)
```
Order → Redirect to Paystack → Complete Payment → Redirect Back → Order Status
        ❌ Page leaves your site
        ❌ Can be blocked by Safari
        ❌ Poor mobile experience
```

### Now (Inline Payment)
```
Order → Modal Opens → Complete Payment → Order Status
        ✅ Stays on your site
        ✅ Works in all browsers
        ✅ Better mobile experience
```

## Payment Channels Available

When the Paystack modal opens, customers can pay with:

- 💳 **Card** (Visa, Mastercard, Verve)
- 📱 **Mobile Money** (MTN, Vodafone, AirtelTigo)
- 🏦 **Bank Transfer**
- 📞 **USSD**
- 📲 **QR Code**
- 🍎 **Apple Pay** (where supported)
- 🤖 **Google Pay** (where supported)

## Troubleshooting

### Modal Not Opening?

Check browser console for errors:
```javascript
// Open browser console (F12)
// Check if Paystack is loaded:
console.log(window.PaystackPop)
// Should show: {setup: function}
```

**Fix**: Make sure Paystack script is loaded in `app/layout.tsx`:
```html
<script src="https://js.paystack.co/v1/inline.js" async></script>
```

### "Paystack public key not configured" Error?

**Fix**: 
1. Check `.env.local` has `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`
2. Restart Next.js dev server (`npm run dev`)
3. Clear browser cache

### Payment Succeeds But Order Not Updated?

**Fix**:
1. Check `/api/payments/verify` endpoint logs
2. Verify Supabase permissions for `shop_orders` table
3. Check `wallet_payments` table has payment record

### Test Payment Failing?

**Fix**:
1. Make sure you're using Paystack **test** keys
2. Use correct test card details (see above)
3. Don't use production cards with test keys!

## Production Checklist

Before going live:

- [ ] Replace test keys with live keys
- [ ] Add environment variables to Vercel
- [ ] Test payment flow in production
- [ ] Set up Paystack webhooks
- [ ] Test with real (small amount) payment
- [ ] Monitor first few transactions
- [ ] Have support contact ready

## Need Help?

- **Paystack Docs**: https://paystack.com/docs/payments/accept-payments
- **Paystack Support**: support@paystack.com
- **Test Cards**: https://paystack.com/docs/payments/test-payments

## Next Steps

1. ✅ Set up environment variables
2. ✅ Test payment flow
3. ✅ Set up webhooks (optional but recommended)
4. ✅ Go live with real keys
5. ✅ Monitor transactions

Happy selling! 🚀
