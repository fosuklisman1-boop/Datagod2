# Paystack Inline Payment for Storefront

## Overview

The storefront payment system now uses Paystack's inline (embedded) payment modal instead of redirecting users to an external payment page. This provides a better user experience with:

- No page redirects during payment
- Seamless payment flow within your site
- Support for all Paystack payment channels (cards, mobile money, bank transfer)
- Better conversion rates
- Works across all browsers including Safari

## How It Works

### Payment Flow

1. **Order Creation**: Customer places an order on the storefront
2. **Order Confirmation**: Customer is redirected to order confirmation page
3. **Payment Initiation**: Customer clicks "Proceed to Payment" button
4. **Inline Modal**: Paystack payment modal opens within the page (no redirect)
5. **Payment Processing**: Customer completes payment in the modal
6. **Payment Verification**: Payment is verified automatically
7. **Order Status**: Customer is redirected to order status page

### Technical Implementation

#### 1. Payment Service (`lib/payment-service.ts`)

The `openPaystackModal` function handles opening the Paystack inline payment modal:

```typescript
export function openPaystackModal(config: {
  key: string              // Paystack public key
  email: string           // Customer email
  amount: number          // Amount in GHS/NGN
  reference: string       // Unique payment reference
  channels?: string[]     // Payment channels to enable
  metadata?: Record<string, any>  // Additional metadata
  onClose?: () => void    // Called when modal is closed
  onSuccess?: (reference: string) => void  // Called on successful payment
})
```

#### 2. Order Confirmation Page

The order confirmation page (`app/shop/[slug]/order-confirmation/[orderId]/page.tsx`) implements the payment button:

**Key Features:**
- Initializes payment with order details
- Opens Paystack inline modal
- Handles payment success/failure
- Verifies payment automatically
- Redirects to order status page

**Payment Handler:**
```typescript
const handlePayment = async () => {
  // 1. Initialize payment
  const response = await fetch("/api/payments/initialize", {
    method: "POST",
    body: JSON.stringify({
      amount: order.total_price,
      email: order.customer_email,
      userId: order.id,
      shopId: order.shop_id,
      orderId: order.id,
      shopSlug: shopSlug,
    }),
  })

  // 2. Open Paystack modal
  await openPaystackModal({
    key: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
    email: order.customer_email,
    amount: order.total_price,
    reference: paymentData.reference,
    onSuccess: async (reference) => {
      // 3. Verify payment and redirect
      await verifyPayment(reference)
      router.push(`/shop/${shopSlug}/order-status/${orderId}?payment=success`)
    },
  })
}
```

#### 3. Payment API Endpoint

The `/api/payments/initialize` endpoint:
- Creates payment record in database
- Generates unique payment reference
- Calls Paystack API to initialize transaction
- Returns payment reference and access code

#### 4. Payment Verification

The `/api/payments/verify` endpoint:
- Verifies payment with Paystack
- Updates payment status in database
- Updates shop order payment status
- Creates profit record for shop owner

## Configuration

### Environment Variables

Add these to your `.env.local` file:

```env
# Paystack Public Key (for inline modal)
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_xxx

# Paystack Secret Key (for API calls)
PAYSTACK_SECRET_KEY=sk_test_xxx
```

Get your keys from: https://dashboard.paystack.com -> Settings -> API Keys & Webhooks

### Paystack Script

The Paystack inline script is already loaded in the root layout (`app/layout.tsx`):

```html
<script src="https://js.paystack.co/v1/inline.js" async></script>
```

## Payment Channels

The implementation supports all Paystack payment channels:

- **Card**: Visa, Mastercard, Verve
- **Mobile Money**: MTN Mobile Money, Vodafone Cash, AirtelTigo Money
- **Bank Transfer**: Direct bank transfer
- **USSD**: USSD codes for bank payments
- **QR Code**: QR code payments
- **Apple Pay**: Apple Pay (where available)
- **Google Pay**: Google Pay (where available)

Channels can be configured in the payment initialization:

```typescript
channels: ["card", "mobile_money", "bank_transfer"]
```

## Benefits vs Redirect Payment

### Inline Payment (Current)
✅ No page redirects  
✅ Better user experience  
✅ Higher conversion rates  
✅ Works in all browsers  
✅ Seamless integration  
✅ Better mobile experience  
✅ Maintains site context  

### Redirect Payment (Previous)
❌ Redirects to external page  
❌ Can be blocked by Safari  
❌ Lower conversion rates  
❌ Context switching  
❌ Back button issues  

## Error Handling

The implementation includes comprehensive error handling:

1. **Payment Initialization Errors**: Shows error toast message
2. **Payment Cancellation**: Shows info toast when user closes modal
3. **Verification Errors**: Redirects to order status page anyway
4. **Network Errors**: Shows error toast with retry option

## Testing

### Test Cards

Use these Paystack test cards for testing:

**Successful Payment:**
- Card: `4084 0840 8408 4081`
- CVV: `408`
- Expiry: Any future date
- PIN: `0000`
- OTP: `123456`

**Failed Payment:**
- Card: `5060 6666 6666 6666`
- CVV: Any 3 digits
- Expiry: Any future date

### Test Flow

1. Create a test order on your storefront
2. Navigate to order confirmation page
3. Click "Proceed to Payment"
4. Use test card in Paystack modal
5. Complete payment
6. Verify order status updates to "paid"

## Database Schema

### wallet_payments table

Stores all payment records:

```sql
- id: UUID (primary key)
- shop_id: UUID (shop reference)
- order_id: UUID (order reference)
- amount: DECIMAL (payment amount)
- fee: DECIMAL (transaction fee)
- reference: TEXT (unique payment reference)
- status: TEXT (pending/completed/failed)
- payment_method: TEXT (paystack)
- created_at: TIMESTAMP
- updated_at: TIMESTAMP
```

### shop_orders table

Payment status is tracked here:

```sql
- payment_status: TEXT (pending/completed/failed)
- updated_at: TIMESTAMP (updated on payment completion)
```

## Webhook Integration

For production, set up Paystack webhooks to handle payment notifications:

1. Go to: https://dashboard.paystack.com -> Settings -> Webhooks
2. Add webhook URL: `https://your-domain.com/api/webhooks/paystack`
3. Select events: `charge.success`
4. Save webhook secret in environment variables

The webhook will automatically:
- Verify payments
- Update order status
- Credit shop owner profits
- Send confirmation emails

## Troubleshooting

### Paystack Modal Not Opening

**Problem**: Modal doesn't open when clicking payment button  
**Solution**: Check that Paystack script is loaded in browser console:
```javascript
console.log(window.PaystackPop) // Should not be undefined
```

### Invalid Public Key Error

**Problem**: "Invalid public key" error  
**Solution**: Verify `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` is set correctly in `.env.local`

### Payment Not Verifying

**Problem**: Payment succeeds but order status doesn't update  
**Solution**: Check verification endpoint logs and ensure database has proper permissions

### Modal Closes Immediately

**Problem**: Modal opens then closes  
**Solution**: Check for JavaScript errors in browser console and ensure amount is valid

## Security Considerations

1. **Public Key Only**: The inline modal only uses the public key (safe for client-side)
2. **Secret Key Protection**: Secret key is only used server-side for verification
3. **Reference Validation**: Payment references are validated before crediting
4. **Amount Verification**: Server verifies payment amount matches order total
5. **Webhook Signature**: Webhook events are verified using secret signature

## Migration from Redirect Payment

If you're migrating from redirect payment to inline:

1. ✅ Update `.env.local` with public key
2. ✅ Update order confirmation page (already done)
3. ✅ Update payment service (already done)
4. ✅ Test payment flow thoroughly
5. ✅ Monitor for any issues
6. ✅ Update documentation

No database migrations needed - the payment flow is compatible with existing schema.

## Support

For issues with Paystack integration:
- Paystack Documentation: https://paystack.com/docs
- Paystack Support: support@paystack.com
- Test Dashboard: https://dashboard.paystack.com

For issues with the implementation:
- Check browser console for errors
- Check server logs for API errors
- Verify environment variables are set
- Test with Paystack test cards first
