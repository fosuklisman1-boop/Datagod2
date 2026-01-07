# Phase 3: MTN API Integration Testing Plan

**Phase**: 3 (Integration Testing)  
**Status**: 🔄 IN PROGRESS  
**Start Date**: January 2026  
**Estimated Duration**: 1-2 weeks

---

## 📋 Overview

Phase 3 focuses on validating the complete MTN API integration with real API credentials and endpoints. This phase includes environment setup, integration testing, load testing, and production deployment preparation.

## 🎯 Phase 3 Objectives

1. **Environment Setup** ✅
   - Configure MTN API credentials (sandbox/staging)
   - Set up environment variables
   - Verify connectivity to MTN API

2. **Integration Testing** ✅
   - Test auto-fulfillment flow end-to-end
   - Test manual fulfillment flow
   - Verify webhook signature validation
   - Test error scenarios and retry logic
   - Validate SMS notifications

3. **Load Testing** ✅
   - Test with concurrent orders
   - Monitor API response times
   - Validate database performance
   - Identify bottlenecks

4. **Monitoring & Alerting** ✅
   - Configure fulfillment endpoint metrics
   - Set up error rate alerts
   - Create monitoring dashboards

5. **Production Deployment Plan** ✅
   - Gradual rollout strategy
   - Rollback procedures
   - Health check configuration

---

## 📋 Pre-Testing Checklist

### Database Migrations
- [ ] Verify migrations 0035 and 0036 are created
- [ ] Apply migrations to staging database
- [ ] Verify tables created: `mtn_fulfillment_tracking`, `app_settings`
- [ ] Verify indexes created
- [ ] Confirm RLS policies applied

### Environment Variables (Staging)
```dotenv
# MTN API Configuration
MTN_API_KEY=<sandbox-api-key>
MTN_WEBHOOK_SECRET=<sandbox-webhook-secret>
MTN_API_BASE_URL=https://sykesofficial.net (staging endpoint)

# SMS Configuration
SMS_API_KEY=<existing-sms-service-key>

# Database
NEXT_PUBLIC_SUPABASE_URL=<staging-db-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<staging-service-key>
```

### Code Review
- [ ] Review `lib/mtn-fulfillment.ts` for any staging adjustments
- [ ] Review `app/api/fulfillment/process-order/route.ts`
- [ ] Review `app/api/admin/fulfillment/manual-fulfill/route.ts`
- [ ] Verify all error handling is in place
- [ ] Check logging/debugging capabilities

---

## 🧪 Integration Testing Scenarios

### Scenario 1: Auto-Fulfillment Flow (Enabled)
**Objective**: Verify MTN orders are automatically sent to MTN API when auto-fulfillment is enabled

**Steps**:
1. Admin enables auto-fulfillment toggle in Settings > MTN
2. Create test order: 1GB MTN data
3. Complete payment via Paystack
4. Verify order is routed to `/api/fulfillment/process-order`
5. Verify `createMTNOrder()` is called with correct parameters
6. Verify MTN API returns order ID
7. Verify `mtn_fulfillment_tracking` record is created
8. Verify SMS notification is sent
9. Verify `shop_orders.order_status = "processing"`
10. Verify order never appears in admin fulfillment queue

**Expected Results**:
- ✅ Order processed to MTN immediately
- ✅ Tracking record created with status "pending"
- ✅ SMS sent to customer
- ✅ Admin queue remains empty

**Failure Scenarios**:
- MTN API returns error → Order status set to "failed", SMS sent with error
- Phone number invalid → Validation error before MTN API call
- Network timeout → Retry logic triggers (5min → 15min → 1h → 24h)

---

### Scenario 2: Manual Fulfillment Flow (Disabled)
**Objective**: Verify MTN orders are queued when auto-fulfillment is disabled

**Steps**:
1. Admin disables auto-fulfillment toggle in Settings > MTN
2. Create test order: 2GB MTN data
3. Complete payment via Paystack
4. Verify order is routed to `/api/fulfillment/process-order`
5. Verify order_status is set to "pending_download" (NOT sent to MTN)
6. Verify SMS notification is sent (queued message)
7. Verify order appears in Admin > Orders > Fulfillment tab
8. Admin clicks "Fulfill" button
9. Verify POST to `/api/admin/fulfillment/manual-fulfill`
10. Verify `createMTNOrder()` is called
11. Verify MTN API returns order ID
12. Verify tracking record created
13. Verify SMS sent (fulfillment message)
14. Verify UI shows "Fulfilled" badge
15. Verify order removed from queue on refresh

**Expected Results**:
- ✅ Order queued (pending_download status)
- ✅ Order appears in admin queue
- ✅ Admin can manually trigger fulfillment
- ✅ Manual fulfillment sends to MTN successfully

---

### Scenario 3: Webhook Handling
**Objective**: Verify webhook signature validation and status updates

**Steps**:
1. Order sent to MTN (auto or manual)
2. Simulate MTN webhook: POST to `/api/webhook/mtn`
3. Include webhook payload with valid HMAC signature
4. Verify webhook handler validates signature
5. Verify order status updated to "success" or "failed"
6. Verify final SMS sent (delivery confirmation)
7. Test invalid signature → Verify 401 Unauthorized response
8. Test tampered payload → Verify signature validation fails

**Expected Results**:
- ✅ Valid webhooks processed correctly
- ✅ Invalid signatures rejected
- ✅ Status updates persist to database
- ✅ SMS notifications sent

---

### Scenario 4: Error Handling & Retry Logic
**Objective**: Verify graceful error handling and automatic retry

**Steps**:
1. Create test order with valid details
2. Simulate MTN API error (500, timeout, etc.)
3. Verify error is caught and logged
4. Verify SMS sent with error message
5. Verify `mtn_fulfillment_tracking.retry_count` incremented
6. Verify next retry scheduled (5min from first attempt)
7. Wait for retry or manually trigger via admin panel
8. Verify retry attempts up to configured limit
9. Verify order status updates after final retry

**Expected Results**:
- ✅ Errors don't crash the app
- ✅ Customer notified of issue
- ✅ Automatic retries scheduled
- ✅ Admin can see retry history

---

### Scenario 5: Network Detection & Phone Validation
**Objective**: Verify phone number validation and network detection

**Tests**:
1. Test phone format: `0541234567` (Ghana format) → Normalized to MTN
2. Test phone format: `541234567` (no leading 0) → Normalized correctly
3. Test phone format: `233541234567` (with country code) → Normalized correctly
4. Test invalid phone: `1234567` → Validation error
5. Test MTN prefix: `0541234567` → Detected as MTN
6. Test non-MTN prefix: `0551234567` → Detected as Telecel
7. Test network mismatch: Order network=MTN, phone=Telecel → Validation error

**Expected Results**:
- ✅ All formats normalized correctly
- ✅ Network detected from phone prefix
- ✅ Validation prevents invalid orders

---

### Scenario 6: Other Networks (Telecel, AirtelTigo)
**Objective**: Verify non-MTN orders still work via existing services

**Steps**:
1. Create Telecel order
2. Complete payment
3. Verify order is routed to existing `atishareService`
4. Verify MTN router doesn't interfere
5. Verify order completes normally
6. Repeat for AirtelTigo

**Expected Results**:
- ✅ Other networks unaffected
- ✅ Existing fulfillment flow continues
- ✅ No errors or conflicts

---

## 📊 Load Testing

### Concurrent Orders Test
**Objective**: Test system under load with multiple concurrent orders

**Scenario**:
- Create 10 concurrent MTN orders
- Complete payments quickly
- Monitor:
  - API response times
  - Database query performance
  - MTN API rate limits
  - Error rates

**Expected Results**:
- ✅ All orders processed successfully
- ✅ Response times < 2 seconds
- ✅ No database connection errors
- ✅ No rate limit violations

### Sustained Load Test
**Objective**: Test system over time with steady order flow

**Scenario**:
- 1 order per second for 10 minutes (600 orders)
- Mix of auto and manual fulfillment
- Monitor:
  - System stability
  - Memory usage
  - Database connections
  - Error accumulation

**Expected Results**:
- ✅ No memory leaks
- ✅ Consistent response times
- ✅ Zero errors under sustained load
- ✅ Database remains responsive

---

## 🔍 Testing Tools & Setup

### Test Data
**File**: `PHASE3_TEST_DATA.sql`
- Test orders with various phone formats
- Test user accounts for admin access
- Test payment records

### Test Scripts
**File**: `scripts/phase3-integration-tests.ts`
- Automated integration tests
- API endpoint tests
- Webhook simulation

### Monitoring
**Dashboard Requirements**:
- Fulfillment success rate
- Average response time
- Error rate trend
- Retry rate
- SMS delivery rate

---

## ✅ Test Execution Checklist

### Week 1: Setup & Smoke Tests
- [ ] Day 1-2: Environment configuration
  - [ ] MTN API credentials obtained
  - [ ] Environment variables set in staging
  - [ ] Database migrations applied
  - [ ] Connectivity verified
  
- [ ] Day 3: Smoke tests
  - [ ] API endpoints responding
  - [ ] Database accessible
  - [ ] Phone validation working
  - [ ] SMS service connected

### Week 2: Integration Tests
- [ ] Day 4-5: Scenario 1 & 2 (Auto/Manual fulfillment)
  - [ ] Complete auto-fulfillment flow
  - [ ] Complete manual fulfillment flow
  - [ ] End-to-end order creation to delivery
  
- [ ] Day 6: Scenario 3 & 4 (Webhooks & Errors)
  - [ ] Webhook signature validation
  - [ ] Error handling scenarios
  - [ ] Retry logic verification
  
- [ ] Day 7: Scenario 5 & 6 (Validation & Networks)
  - [ ] Phone validation edge cases
  - [ ] Other networks unaffected
  - [ ] Network detection accuracy

### Week 2: Performance & Production Ready
- [ ] Day 8: Load testing
  - [ ] Concurrent order handling
  - [ ] Performance metrics collection
  - [ ] Bottleneck identification
  
- [ ] Day 9-10: Production preparation
  - [ ] Monitoring dashboards ready
  - [ ] Alerts configured
  - [ ] Rollback plan documented
  - [ ] Deployment script ready

---

## 📈 Success Criteria

### Functional Testing
- ✅ All 6 scenarios pass 100%
- ✅ No critical bugs found
- ✅ All error paths handled gracefully
- ✅ SMS notifications reliable

### Performance Testing
- ✅ API response time < 2 seconds (p95)
- ✅ Database queries < 200ms (p95)
- ✅ Webhook processing < 1 second
- ✅ Zero timeouts under load

### Reliability
- ✅ 99.9% order success rate
- ✅ All retries successful
- ✅ Zero data loss scenarios
- ✅ Complete audit trail

### Security
- ✅ Webhook signatures validated
- ✅ Admin auth verified
- ✅ Phone data encrypted in transit
- ✅ No sensitive data in logs

---

## 🚀 Deployment Readiness

### Before Production
- [ ] All tests passing
- [ ] Monitoring configured
- [ ] Runbooks created
- [ ] Team trained
- [ ] Rollback procedure tested
- [ ] Backup strategy verified

### Gradual Rollout Strategy
1. **Phase 1**: 5% of MTN orders (monitor 24h)
2. **Phase 2**: 25% of MTN orders (monitor 48h)
3. **Phase 3**: 50% of MTN orders (monitor 48h)
4. **Phase 4**: 100% of MTN orders

### Health Checks
- Fulfillment endpoint responding
- Error rate normal
- Response times acceptable
- SMS delivery working
- Webhook processing functioning

---

## 📞 Support & Escalation

### Issue Escalation Path
1. Check logs: `/app/api/fulfillment/process-order/route.ts` (error logging)
2. Check database: `mtn_fulfillment_tracking` table
3. Check MTN API status page
4. Escalate to MTN API support if needed

### Common Issues & Fixes
See: `PHASE3_TROUBLESHOOTING.md`

---

## 📚 Related Documentation

- Implementation Summary: `MTN_PHASE2_IMPLEMENTATION_SUMMARY.md`
- Quick Reference: `MTN_PHASE2_QUICK_REFERENCE.md`
- Admin Guide: `MTN_ADMIN_UI_VISUAL_GUIDE.md`
- API Plan: `MTN_API_INTEGRATION_PLAN.md`

---

## 🎯 Timeline

| Phase | Duration | Start | End | Status |
|-------|----------|-------|-----|--------|
| Setup | 2-3 days | Jan 6 | Jan 8 | 🔄 |
| Integration Tests | 3-4 days | Jan 9 | Jan 12 | 🔄 |
| Load Testing | 1-2 days | Jan 13 | Jan 14 | ⏳ |
| Production Deploy | 1-2 days | Jan 15 | Jan 16 | ⏳ |

**Target Completion**: Mid-January 2026

---

**Next Steps**: 
1. Obtain MTN API sandbox credentials
2. Set up staging environment
3. Run smoke tests
4. Execute integration tests
5. Validate results
6. Prepare for production deployment

---

**Phase 3 Status**: 🔄 READY TO BEGIN
