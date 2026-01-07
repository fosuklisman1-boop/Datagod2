# Environment Variables Checklist

## Required for AT-iShare Fulfillment

### Supabase (Already configured)
- ✅ `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- ✅ `SUPABASE_SERVICE_ROLE_KEY` - Service role key for backend operations

### Code Craft Network API (MUST BE SET)
- `CODECRAFT_API_KEY` - **REQUIRED** - Your Code Craft API key
  - Used to authenticate requests to Code Craft API
  - File: `lib/at-ishare-service.ts` line 6
  
- `CODECRAFT_API_URL` - Optional
  - Defaults to: `https://api.codecraftnetwork.com/api`
  - Override if Code Craft API endpoint is different
  - File: `lib/at-ishare-service.ts` line 5

---

## How to Set Environment Variables in Vercel

1. Go to Vercel Dashboard
2. Select your project (Datagod2)
3. Click **Settings**
4. Go to **Environment Variables**
5. Add these variables:

```
Name: CODECRAFT_API_KEY
Value: [your-api-key-here]
Environments: Production, Preview, Development
```

```
Name: CODECRAFT_API_URL
Value: https://api.codecraftnetwork.com/api
Environments: Production, Preview, Development
```

6. Click **Save**
7. Trigger a new deployment (or re-deploy current commit)

---

## Verification

After setting environment variables:

1. **Check deployment logs** - Should see no "undefined" errors for CODECRAFT_API_KEY
2. **Test order** - Place an AT - iShare order
3. **Check fulfillment** - Look for `[CODECRAFT-FULFILL]` in Vercel logs
4. **Verify logs** - Check if `fulfillment_logs` table has entries

---

## Location of Usage

### Fulfillment Service
- File: `lib/at-ishare-service.ts`
- Line 5: API URL (with fallback default)
- Line 6: API Key (required)
- Line 71-80: Request building with these variables
- Line 85-92: API call to Code Craft endpoint

### Example API Request Built
```json
{
  "agent_api": "[value of CODECRAFT_API_KEY]",
  "recipient_number": "0554226398",
  "network": "AT",
  "gig": "1",
  "reference_id": "order-id-uuid"
}
```

---

## If Fulfillment is Not Working

**Check checklist:**
1. ✓ `CODECRAFT_API_KEY` is set in Vercel environment variables
2. ✓ Project has been re-deployed after setting variables
3. ✓ Check Vercel logs for `[CODECRAFT-FULFILL]` prefix
4. ✓ Look for error messages about missing API key
5. ✓ Verify Code Craft API endpoint is correct
6. ✓ Test with correct phone number format

