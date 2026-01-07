# Phase 3: Smoke Tests & Quick Validation

**Purpose**: Rapid verification that all systems are functional before integration tests

---

## 🚀 Pre-Test Checklist (5 minutes)

```bash
# 1. Check environment variables
echo "MTN_API_KEY: $MTN_API_KEY" | head -c 50
echo "MTN_WEBHOOK_SECRET: $MTN_WEBHOOK_SECRET" | head -c 50

# 2. Check server is running
curl -s http://localhost:3000/api/health || echo "❌ Server not responding"

# 3. Check database connection
curl -s http://localhost:3000/api/admin/test/db-connection | jq .

# 4. Check service library loaded
curl -s http://localhost:3000/api/admin/test/service-library | jq .

# 5. Check migrations applied
curl -s http://localhost:3000/api/admin/test/migrations | jq .
```

---

## ✅ Smoke Test 1: Environment Variables

**Objective**: Verify all required environment variables are set

**Command**:
```bash
curl -X POST http://localhost:3000/api/test/check-env \
  -H "Content-Type: application/json"
```

**Expected Response**:
```json
{
  "success": true,
  "variables": {
    "MTN_API_KEY": "✓ Set",
    "MTN_WEBHOOK_SECRET": "✓ Set",
    "MTN_API_BASE_URL": "✓ Set",
    "SUPABASE_URL": "✓ Set",
    "SUPABASE_ANON_KEY": "✓ Set"
  }
}
```

**If Failed**:
- Check `.env.local` file exists
- Verify variable names are exactly correct
- Restart development server: `npm run dev`

---

## ✅ Smoke Test 2: Database Connection

**Objective**: Verify database is accessible and tables exist

**Command**:
```bash
curl -X GET http://localhost:3000/api/test/db-status
```

**Expected Response**:
```json
{
  "success": true,
  "database": "connected",
  "tables": {
    "mtn_fulfillment_tracking": "✓ Exists",
    "app_settings": "✓ Exists",
    "shop_orders": "✓ Exists",
    "users": "✓ Exists"
  },
  "rows_count": {
    "mtn_fulfillment_tracking": 0,
    "app_settings": 1
  }
}
```

**If Failed**:
- Check database URL in environment
- Verify migrations were applied: `npx supabase migration list`
- Re-run migrations: `npx supabase db push`

---

## ✅ Smoke Test 3: Phone Validation

**Objective**: Verify phone number validation is working

**Test Case 1**: Ghana format `0541234567`
```bash
curl -X POST http://localhost:3000/api/test/validate-phone \
  -H "Content-Type: application/json" \
  -d '{"phone":"0541234567"}'
```

Expected:
```json
{
  "valid": true,
  "normalized": "541234567",
  "network": "MTN",
  "raw": "0541234567"
}
```

**Test Case 2**: International format `233541234567`
```bash
curl -X POST http://localhost:3000/api/test/validate-phone \
  -H "Content-Type: application/json" \
  -d '{"phone":"233541234567"}'
```

Expected:
```json
{
  "valid": true,
  "normalized": "541234567",
  "network": "MTN",
  "raw": "233541234567"
}
```

**Test Case 3**: Invalid format `123`
```bash
curl -X POST http://localhost:3000/api/test/validate-phone \
  -H "Content-Type: application/json" \
  -d '{"phone":"123"}'
```

Expected:
```json
{
  "valid": false,
  "error": "Invalid phone number format"
}
```

**If Failed**:
- Check `lib/mtn-fulfillment.ts` function `normalizePhoneNumber()`
- Verify phone number patterns
- Check test cases in `lib/mtn-fulfillment.test.ts`

---

## ✅ Smoke Test 4: MTN API Connectivity

**Objective**: Verify MTN API endpoint is reachable and API key works

**Command**:
```bash
curl -X GET "https://sandbox.sykesofficial.net/api/status" \
  -H "X-API-KEY: $MTN_API_KEY"
```

Expected Response:
```json
{
  "status": "ok",
  "service": "MTN API",
  "version": "2.0"
}
```

**If Failed**:
- Check API key is correct
- Check API URL is correct (sandbox vs production)
- Check network connectivity: `ping sandbox.sykesofficial.net`
- Verify firewall allows outbound HTTPS
- Check MTN API status page

---

## ✅ Smoke Test 5: Webhook Signature Validation

**Objective**: Verify webhook signature validation works

**Setup**:
```bash
# Get webhook secret
echo $MTN_WEBHOOK_SECRET

# Create test payload
PAYLOAD='{"order_id":"TEST-001","status":"completed"}'

# Generate HMAC signature
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$MTN_WEBHOOK_SECRET" | sed 's/.*= //')

echo "Payload: $PAYLOAD"
echo "Signature: $SIGNATURE"
```

**Send Test Webhook**:
```bash
curl -X POST http://localhost:3000/api/webhook/mtn \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIGNATURE" \
  -d "$PAYLOAD"
```

Expected Response:
```json
{
  "success": true,
  "message": "Webhook processed",
  "order_id": "TEST-001"
}
```

**If Failed (401 Unauthorized)**:
- Check webhook secret is correct
- Verify signature generation algorithm (SHA256 HMAC)
- Check header name is exactly `X-Webhook-Signature`

---

## ✅ Smoke Test 6: Settings Toggle

**Objective**: Verify auto-fulfillment toggle can be read and updated

**Get Current Setting**:
```bash
curl -X GET http://localhost:3000/api/admin/settings/mtn-auto-fulfillment \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Expected:
```json
{
  "success": true,
  "setting": {
    "name": "mtn_auto_fulfillment_enabled",
    "value": true
  }
}
```

**Toggle Setting**:
```bash
curl -X POST http://localhost:3000/api/admin/settings/mtn-auto-fulfillment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{"enabled": false}'
```

Expected:
```json
{
  "success": true,
  "setting": {
    "name": "mtn_auto_fulfillment_enabled",
    "value": false
  }
}
```

**If Failed**:
- Check admin authentication token is valid
- Verify `app_settings` table exists and has row
- Check endpoint exists in `app/api/admin/settings/mtn-auto-fulfillment/route.ts`

---

## ✅ Smoke Test 7: Order Creation

**Objective**: Verify a test order can be created

**Create Test Order**:
```bash
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "0541234567",
    "network": "MTN",
    "volume_gb": 1,
    "customer_name": "Test User",
    "customer_email": "test@example.com"
  }'
```

Expected:
```json
{
  "success": true,
  "order": {
    "id": "ORD-2026-001",
    "status": "pending",
    "order_status": "pending",
    "network": "MTN",
    "phone_number": "0541234567",
    "volume_gb": 1,
    "price": 5.99
  }
}
```

**If Failed**:
- Check order creation endpoint exists
- Verify database has `shop_orders` table
- Check required fields are provided

---

## ✅ Smoke Test 8: Admin Panel Access

**Objective**: Verify admin panel is accessible

**Navigate to Admin Panel**:
```
http://localhost:3000/admin
```

**Expected**:
- ✓ Admin dashboard loads
- ✓ Orders tab visible
- ✓ Settings > MTN tab available
- ✓ Fulfillment tab shows in Orders page
- ✓ Auto-fulfillment toggle visible

**If Failed**:
- Check admin authentication
- Verify user has admin role
- Check sidebar component includes MTN links

---

## 🧪 Running All Smoke Tests

**Create Script**: `scripts/run-smoke-tests.sh`

```bash
#!/bin/bash

echo "🧪 Phase 3 Smoke Tests"
echo "===================="
echo ""

FAILED=0

# Test 1: Environment
echo "1️⃣  Environment Variables..."
curl -s http://localhost:3000/api/test/check-env | jq '.success' | grep -q "true" && echo "✅ PASS" || { echo "❌ FAIL"; FAILED=$((FAILED+1)); }

# Test 2: Database
echo "2️⃣  Database Connection..."
curl -s http://localhost:3000/api/test/db-status | jq '.success' | grep -q "true" && echo "✅ PASS" || { echo "❌ FAIL"; FAILED=$((FAILED+1)); }

# Test 3: Phone Validation
echo "3️⃣  Phone Validation..."
curl -s -X POST http://localhost:3000/api/test/validate-phone \
  -H "Content-Type: application/json" \
  -d '{"phone":"0541234567"}' | jq '.valid' | grep -q "true" && echo "✅ PASS" || { echo "❌ FAIL"; FAILED=$((FAILED+1)); }

# Test 4: MTN API Connectivity
echo "4️⃣  MTN API Connectivity..."
curl -s -I "https://sandbox.sykesofficial.net/api/status" | grep -q "200" && echo "✅ PASS" || { echo "❌ FAIL"; FAILED=$((FAILED+1)); }

# Test 5: Webhook Signature
echo "5️⃣  Webhook Signature..."
SIGNATURE=$(echo -n '{}' | openssl dgst -sha256 -hmac "$MTN_WEBHOOK_SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:3000/api/webhook/mtn \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIGNATURE" \
  -d '{}' | jq '.success' | grep -q "true" && echo "✅ PASS" || { echo "❌ FAIL"; FAILED=$((FAILED+1)); }

echo ""
echo "===================="
if [ $FAILED -eq 0 ]; then
  echo "✅ All smoke tests passed! Ready for integration tests."
else
  echo "❌ $FAILED test(s) failed. Check logs above."
  exit 1
fi
```

**Run**:
```bash
chmod +x scripts/run-smoke-tests.sh
./scripts/run-smoke-tests.sh
```

---

## ⏱️ Time Estimate

- Environment check: 1 min
- Test 1-3: 3 min
- Test 4-5: 2 min
- Test 6-8: 3 min
- **Total: ~10 minutes**

---

## 📋 Quick Checklist

After running all smoke tests:
- [ ] Environment variables verified
- [ ] Database connection confirmed
- [ ] Phone validation working
- [ ] MTN API reachable
- [ ] Webhook signature valid
- [ ] Settings toggle functional
- [ ] Order creation working
- [ ] Admin panel accessible

**If all ✅**: Ready for Integration Tests!  
**If any ❌**: See troubleshooting section in `PHASE3_TROUBLESHOOTING.md`

---

**Status**: 🧪 SMOKE TESTS READY TO RUN

**Next**: Execute all 8 smoke tests, then proceed to integration testing scenarios
