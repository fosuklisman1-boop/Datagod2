# Phase 3: Environment Setup & Configuration Guide

**Date**: January 2026  
**Purpose**: Configure staging environment for MTN API integration testing

---

## 🔧 Step 1: Obtain MTN API Credentials

### Sandbox Access
1. Contact MTN API Provider (Sykes)
2. Request sandbox credentials:
   - **Sandbox API Key**: Will start with `sandbox_` or similar
   - **Webhook Secret**: For HMAC signature verification
   - **API Base URL**: Usually `https://sandbox.sykesofficial.net` or similar
   - **Test Account**: With sufficient balance for testing

3. Verify credentials:
   - Test connectivity
   - Verify authentication
   - Check rate limits

### Documentation Needed
- MTN API docs (webhook format, retry behavior, etc.)
- Sandbox endpoint specs
- Rate limiting details
- Error code reference

---

## 🌍 Step 2: Environment Variables Setup

### Create Staging Environment File

**File**: `.env.staging` (or update `.env.local` for staging)

```dotenv
# ===== MTN API Configuration (STAGING) =====
MTN_API_KEY=sandbox_YOUR_SANDBOX_KEY_HERE
MTN_WEBHOOK_SECRET=your_webhook_secret_here
MTN_API_BASE_URL=https://sandbox.sykesofficial.net
MTN_API_TIMEOUT=30000

# ===== Database Configuration (STAGING) =====
NEXT_PUBLIC_SUPABASE_URL=https://your-staging-supabase.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=staging_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=staging_service_role_key_here

# ===== API Configuration =====
NEXT_PUBLIC_API_URL=http://localhost:3000
NODE_ENV=development  # Use "staging" or "development"

# ===== SMS Configuration (Existing) =====
SMS_API_KEY=your_existing_sms_key

# ===== Paystack Configuration =====
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_YOUR_TEST_KEY
PAYSTACK_SECRET_KEY=sk_test_YOUR_TEST_SECRET

# ===== Logging =====
LOG_LEVEL=debug
MTN_DEBUG_MODE=true  # Enable detailed logging for testing
```

### Update Development Environment

**File**: `.env.local` (for local testing)

```dotenv
# Same as above, but point to local/staging databases
MTN_API_KEY=sandbox_YOUR_SANDBOX_KEY_HERE
MTN_WEBHOOK_SECRET=your_webhook_secret_here
MTN_API_BASE_URL=https://sandbox.sykesofficial.net
```

---

## 🗄️ Step 3: Database Migration Setup

### Verify Migrations Exist

```bash
# Check migration files
ls migrations/
# Should see:
# - 0035_mtn_fulfillment_tracking.sql
# - 0036_app_settings.sql
```

### Apply Migrations to Staging Database

```bash
# Using Supabase CLI
npx supabase migration list
npx supabase db push

# Or manually via SQL editor:
# 1. Open Supabase SQL editor
# 2. Run migration 0035 (creates mtn_fulfillment_tracking table)
# 3. Run migration 0036 (creates app_settings table)
# 4. Verify tables created
```

### Verify Tables & Indexes

```sql
-- Check mtn_fulfillment_tracking table
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name = 'mtn_fulfillment_tracking';

-- Check indexes
SELECT indexname FROM pg_indexes 
WHERE schemaname = 'public' AND tablename = 'mtn_fulfillment_tracking';

-- Check app_settings table
SELECT * FROM app_settings;

-- Should return setting for mtn_auto_fulfillment_enabled
```

---

## 🔌 Step 4: API Connectivity Verification

### Test MTN API Connection

**Create**: `scripts/test-mtn-api-connectivity.ts`

```typescript
import fetch from 'node-fetch'

async function testMTNConnectivity() {
  const apiKey = process.env.MTN_API_KEY
  const baseUrl = process.env.MTN_API_BASE_URL

  console.log('🧪 Testing MTN API Connectivity')
  console.log(`   Base URL: ${baseUrl}`)
  console.log(`   API Key: ${apiKey?.substring(0, 10)}...`)

  try {
    // Test 1: Basic connectivity
    const response = await fetch(`${baseUrl}/health`, {
      headers: { 'X-API-KEY': apiKey }
    })

    console.log(`✅ Health Check: ${response.status}`)

    // Test 2: Authentication
    const authTest = await fetch(`${baseUrl}/orders`, {
      method: 'GET',
      headers: { 'X-API-KEY': apiKey }
    })

    console.log(`✅ Authentication: ${authTest.status}`)

    // Test 3: Check balance
    const balanceTest = await fetch(`${baseUrl}/balance`, {
      method: 'GET',
      headers: { 'X-API-KEY': apiKey }
    })

    const balance = await balanceTest.json()
    console.log(`✅ Balance: ${balance.amount} ${balance.currency}`)

    console.log('\n✅ All connectivity tests passed!')
  } catch (error) {
    console.error('❌ Connectivity test failed:')
    console.error(error)
    process.exit(1)
  }
}

testMTNConnectivity()
```

### Run Connectivity Test

```bash
npm run dev
# In another terminal:
npx ts-node scripts/test-mtn-api-connectivity.ts
```

---

## 🔐 Step 5: Webhook Configuration

### Setup Webhook Endpoint

**URL**: `https://yourdomain.com/api/webhook/mtn`

### Configure with MTN

1. Log into MTN API dashboard
2. Go to Webhooks section
3. Add webhook endpoint:
   - **URL**: `https://yourdomain.com/api/webhook/mtn`
   - **Secret**: Use value from `MTN_WEBHOOK_SECRET`
   - **Events**: `order.completed`, `order.failed`
4. Test webhook from dashboard
5. Verify signature validation works

### Test Webhook Signature Validation

**Create**: `scripts/test-webhook-signature.ts`

```typescript
import crypto from 'crypto'

function testWebhookSignature() {
  const secret = process.env.MTN_WEBHOOK_SECRET
  const payload = JSON.stringify({
    order_id: 'TEST-123',
    status: 'completed',
    timestamp: Date.now()
  })

  // Create signature like MTN would
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  console.log('Test Webhook Signature:')
  console.log(`Payload: ${payload}`)
  console.log(`Signature: ${signature}`)
  console.log(`Valid: ${signature.length === 64}`)
}

testWebhookSignature()
```

---

## 📊 Step 6: Database Seed Data

### Create Test Data

**File**: `scripts/seed-phase3-test-data.sql`

```sql
-- Insert test users
INSERT INTO users (email, created_at) VALUES
  ('test-admin@datagod.com', NOW()),
  ('test-customer@datagod.com', NOW());

-- Insert test shop
INSERT INTO shops (name, email, user_id) VALUES
  ('Test Shop', 'test-shop@datagod.com', 
   (SELECT id FROM users WHERE email = 'test-admin@datagod.com' LIMIT 1));

-- Insert test settings
INSERT INTO app_settings (setting_name, setting_value, updated_at) VALUES
  ('mtn_auto_fulfillment_enabled', 'true', NOW())
ON CONFLICT (setting_name) DO UPDATE SET 
  setting_value = 'true',
  updated_at = NOW();

-- Verify data
SELECT 'Test data inserted successfully';
```

### Run Seed Script

```bash
npx supabase db reset  # Resets to clean state
npx supabase seed --file scripts/seed-phase3-test-data.sql
```

---

## ✅ Step 7: Verification Checklist

Before starting integration tests, verify:

```bash
# 1. Environment variables set
echo $MTN_API_KEY
echo $MTN_WEBHOOK_SECRET

# 2. Database migrations applied
psql -U postgres -h localhost -c "\dt public.mtn_*"

# 3. API endpoints responding
curl -X GET http://localhost:3000/api/health

# 4. Phone validation working
curl -X POST http://localhost:3000/api/test/validate-phone \
  -H "Content-Type: application/json" \
  -d '{"phone":"0541234567"}'

# 5. Service library accessible
npm run test -- lib/mtn-fulfillment.test.ts

# 6. Database seed data present
curl -X GET http://localhost:3000/api/admin/settings/mtn-auto-fulfillment
```

---

## 🚀 Step 8: Start Development Server

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Server should start on http://localhost:3000
# Open http://localhost:3000/admin to access admin panel
```

---

## 📝 Configuration Verification Checklist

### MTN API Setup
- [ ] Sandbox credentials obtained
- [ ] API key tested with connectivity script
- [ ] Base URL confirmed
- [ ] Webhook secret configured
- [ ] Rate limits documented

### Environment Variables
- [ ] `.env.local` created with MTN credentials
- [ ] Database connection verified
- [ ] SMS service credentials set
- [ ] Paystack test keys configured

### Database
- [ ] Migrations 0035, 0036 applied
- [ ] Tables created: `mtn_fulfillment_tracking`, `app_settings`
- [ ] Indexes verified
- [ ] Test data seeded

### API Endpoints
- [ ] `/api/fulfillment/process-order` responding
- [ ] `/api/admin/fulfillment/manual-fulfill` responding
- [ ] `/api/webhook/mtn` receiving webhooks
- [ ] `/api/admin/settings/mtn-auto-fulfillment` working

### Webhook
- [ ] Endpoint URL registered with MTN
- [ ] Secret key configured
- [ ] Signature validation tested
- [ ] Test webhook successful

### Logging
- [ ] Debug mode enabled (MTN_DEBUG_MODE=true)
- [ ] Logs visible in console
- [ ] Error logging working

---

## 🆘 Troubleshooting

### "Cannot find module 'lib/mtn-fulfillment'"
```bash
# Make sure service library exists
ls lib/mtn-fulfillment.ts
# If missing, copy from Phase 2
```

### "MTN API key invalid"
```bash
# Verify key format and value
echo $MTN_API_KEY
# Ensure key is from sandbox environment
```

### "Webhook signature validation fails"
```bash
# Verify secret matches in MTN dashboard
echo $MTN_WEBHOOK_SECRET
# Test signature generation locally first
```

### "Database table doesn't exist"
```bash
# Re-run migrations
npx supabase db push
# Verify with SQL query
SELECT * FROM mtn_fulfillment_tracking LIMIT 1;
```

---

## 📞 Next Steps

1. ✅ Complete all configuration steps above
2. 📋 Run verification checklist
3. 🧪 Execute smoke tests (in `PHASE3_SMOKE_TESTS.md`)
4. 🔄 Begin integration testing scenarios
5. 📊 Collect performance metrics
6. 🚀 Prepare for production deployment

---

**Setup Status**: 🔄 READY FOR CONFIGURATION

**When Complete**: All 8 steps done → Ready for smoke tests
