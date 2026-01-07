# Currency Flow Documentation - Paystack Integration

## Overview
This document explains how currency (GHS - Ghanaian Cedis) flows through the wallet top-up payment system.

## Complete Currency Flow

### 1. Frontend: Wallet Top-Up Component (`components/wallet-top-up.tsx`)
- **Input**: User enters amount in **GHS** (e.g., `50` means GHS 50.00)
- **Sends to backend**: `{ amount: 50, email: "user@example.com", userId: "..." }`
- **Paystack Client Setup**: Multiplies by 100 → `50 * 100 = 5000` kobo
  - This is **correct** because Paystack's JavaScript client expects amounts in the smallest unit (kobo for NGN, kobo equivalent for other currencies)

### 2. Backend API: Initialize Payment (`app/api/payments/initialize/route.ts`)
- **Receives**: `amount: 50` (in GHS)
- **Stores in DB**: Saves `amount: 50` as-is
- **Calls Paystack library**: `initializePayment({ amount: 50, ... })`

### 3. Backend Library: Paystack Service (`lib/paystack.ts`)
- **Input**: `amount: 50` (in user's base currency)
- **Conversion**: `amount: 50 * 100 = 5000` kobo
- **Sends to Paystack API**: 
  ```json
  {
    "email": "user@example.com",
    "amount": 5000,
    "reference": "WALLET-...",
    "metadata": { ... },
    "channels": ["card", "bank", "ussd", "qr", "mobile_money", ...]
  }
  ```
- **Returns**: Authorization URL with the transaction reference

### 4. Paystack Gateway
- **Displays**: Payment modal to user in the merchant's configured currency
- **User pays**: Using available payment methods (card, bank, USSD, mobile money, etc.)
- **Paystack processes**: Transaction and returns `success` status

### 5. Backend API: Verify Payment (`app/api/payments/verify/route.ts`)
- **Calls**: `verifyPayment(reference)` from Paystack library
- **Receives back**: Amount in the user's base currency (GHS)
  - `lib/paystack.ts` converts: `amount / 100` to get back to GHS
- **Updates database**:
  - Payment record: `status: "completed"`, `amount_received: 50`
  - Wallet: `balance += 50` (in GHS)
  - Transaction: `type: "credit"`, `amount: 50` (in GHS)

### 6. Frontend: Success Confirmation
- **Shows**: "Payment successful! GHS 50.00 added to wallet."
- **Amount**: Displayed in GHS consistently throughout the app

## Amount Units Summary

| Layer | Amount | Unit | Example |
|-------|--------|------|---------|
| User Input | 50 | GHS (display) | "GHS 50" |
| Frontend to Backend | 50 | GHS | `{ amount: 50 }` |
| Backend Paystack API Call | 5000 | Kobo | `{ amount: 5000 }` |
| Paystack Response | 5000 | Kobo | In API response |
| Backend Conversion | 50 | GHS | `5000 / 100 = 50` |
| Database Storage | 50 | GHS | Wallet balance, transactions |
| Frontend Display | 50 | GHS | "GHS 50.00" |

## Currency Configuration

- **Merchant Currency**: Uses Paystack account's configured default currency
- **No explicit currency parameter**: Removed `currency: "GHS"` to avoid conflicts with merchant account settings
- **All amounts in code**: Treated as GHS unless explicitly in kobo for Paystack API calls

## Key Points

✅ **CORRECT** - All flows are consistent
- Frontend: Treats all amounts as GHS
- Backend: Stores all amounts as GHS (base currency)
- Only converts to kobo when calling Paystack API (line 43 in `lib/paystack.ts`)
- Converts back from kobo when receiving from Paystack (line 76 in `lib/paystack.ts`)

✅ **NO MISMATCH** - Frontend and backend use same currency units
- Frontend sends GHS → Backend receives GHS → Stored as GHS
- Kobo conversion only happens at Paystack API boundary

## Testing

To verify the flow works correctly:

1. **Test Amount**: Enter `50` in wallet top-up
2. **Expected in Paystack**: Shows payment for the merchant's configured currency amount
3. **Database**: Should record `50` in `wallet_payments.amount`
4. **Wallet**: Should show balance increased by `50`
5. **Transaction**: Should show credit of `50` with type "credit"

## Troubleshooting

If you see "Currency not supported by merchant":
- Check Paystack merchant account currency settings
- Verify test keys are for the correct environment
- Ensure payment method supports merchant's currency

If amounts don't match:
- Check `lib/paystack.ts` lines 43 and 76 for conversion logic
- Verify database stores amounts without kobo multiplier
- Check frontend display uses `verificationResult.amount` not a recalculated value
