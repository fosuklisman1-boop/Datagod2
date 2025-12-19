# AT-iShare Order Fulfillment Implementation Plan

## Overview
Implement automatic fulfillment of AT-iShare data package orders. This will handle delivering the data to customers after they purchase packages through the data packages page.

## Current State Analysis

### Order Structure
- **Table**: `orders`
- **Relevant Fields**:
  - `id` (UUID) - Order ID
  - `user_id` (UUID) - User who placed order
  - `package_id` (UUID) - Package reference
  - `network` (VARCHAR) - Network name (e.g., "AT-iShare")
  - `size` (VARCHAR) - Package size (e.g., "1GB", "10GB")
  - `price` (DECIMAL) - Price paid
  - `status` (VARCHAR) - Current status (pending/completed/failed)
  - `phone_number` (VARCHAR) - Phone number to deliver to
  - `order_code` (VARCHAR) - Unique order code
  - `created_at`, `updated_at` - Timestamps

### Current Order Flow (Data Packages)
1. User purchases AT-iShare package
2. Order created with `status: 'pending'`
3. Wallet deducted
4. Customer tracked (if user has shop)
5. Notification sent to user
6. SMS sent to user

**Missing**: Actual fulfillment (delivering data)

## Fulfillment Implementation Plan

### Phase 1: Database Schema Updates

#### New Table: `fulfillment_logs`
```sql
CREATE TABLE fulfillment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  network VARCHAR(100),
  phone_number VARCHAR(20),
  status VARCHAR(50), -- pending, processing, success, failed
  attempt_number INT DEFAULT 1,
  max_attempts INT DEFAULT 3,
  api_response JSONB,
  error_message TEXT,
  retry_after TIMESTAMP,
  fulfilled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(order_id)
);
```

#### Add Column to Orders Table
```sql
ALTER TABLE orders ADD COLUMN fulfillment_status VARCHAR(50) DEFAULT 'pending';
```

#### Index for Performance
```sql
CREATE INDEX idx_fulfillment_logs_status ON fulfillment_logs(status);
CREATE INDEX idx_fulfillment_logs_network ON fulfillment_logs(network);
CREATE INDEX idx_orders_fulfillment_status ON orders(fulfillment_status);
```

### Phase 2: AT-iShare API Service

#### Create `lib/at-ishare-service.ts`
**Responsibilities**:
- API authentication/credentials
- Fulfill order API call
- Parse API responses
- Handle errors and retries
- Logging

**Key Methods**:
```typescript
interface FulfillmentRequest {
  phoneNumber: string
  sizeGb: number
  orderId: string
}

interface FulfillmentResponse {
  success: boolean
  reference?: string
  message?: string
  errorCode?: string
}

class ATiShareService {
  async fulfillOrder(request: FulfillmentRequest): Promise<FulfillmentResponse>
  async verifyFulfillment(referenceId: string): Promise<boolean>
  async handleRetry(orderId: string): Promise<void>
}
```

### Phase 3: Fulfillment API Endpoint

#### Create `app/api/orders/fulfillment/route.ts`
**Purpose**: Handle fulfillment process

**Endpoints**:
- `POST /api/orders/fulfillment/trigger` - Manually trigger fulfillment
- `GET /api/orders/fulfillment/:orderId` - Check fulfillment status
- `POST /api/orders/fulfillment/retry` - Retry failed fulfillment

**Logic**:
1. Validate order exists and is AT-iShare
2. Check if already fulfilled
3. Call AT-iShare service
4. Log response to `fulfillment_logs`
5. Update order status
6. Send notification on success/failure
7. Handle retries for failures

### Phase 4: Automatic Fulfillment Trigger

**Option A: On Order Creation (Recommended)**
- Modify `/api/orders/purchase` to call fulfillment immediately after order creation
- Non-blocking (catch errors, don't fail purchase)

**Option B: Background Job (Future)**
- Cron job to fulfill pending AT-iShare orders
- Better for scaling, batch processing

### Phase 5: Order Status Tracking

**Status Flow**:
```
Order Created (status: pending)
  ↓
Fulfillment Triggered
  ↓
FulfillmentLog Created (status: processing)
  ↓
API Call to AT-iShare
  ↓
Success? → Order status: completed, FulfillmentLog: success
Failure? → Order status: failed, FulfillmentLog: failed
  ↓ (with retry)
Retry Logic (max 3 attempts)
```

### Phase 6: Admin Dashboard

**Features**:
- View AT-iShare orders and fulfillment status
- Filter by: network, status, date range, phone number
- Bulk retry failed orders
- View API response details for debugging
- Download fulfillment report

**Location**: `/dashboard/admin/fulfillment` (if admin routes exist)

### Phase 7: Error Handling & Retries

**Retry Strategy**:
- Max 3 retry attempts
- Exponential backoff: 5min, 15min, 1hour
- Log all attempts
- Notify user after each failed attempt

**Error Scenarios**:
1. Invalid phone number
2. AT-iShare API unavailable
3. Insufficient balance at AT-iShare
4. Network timeout
5. Invalid package size
6. Duplicate order prevention

### Phase 8: User Notifications

**Success Notification**:
- "Your AT-iShare data has been delivered to [phone]"
- Order status changed to completed

**Failure Notification**:
- "Failed to deliver data. Retrying..."
- After all retries fail: "Unable to complete order. Contact support."

**SMS Updates**:
- Delivery confirmation with reference ID
- Failure alerts

## Implementation Steps (In Order)

1. ✅ **Plan** (Current)
2. Create database schema updates
3. Build AT-iShare API service
4. Create fulfillment API endpoint
5. Integrate with order purchase flow
6. Add error handling & retries
7. Build admin dashboard (optional)
8. Comprehensive testing
9. Monitoring & logging

## Testing Strategy

### Unit Tests
- AT-iShare API service mocks
- Fulfillment logic validation
- Retry mechanism

### Integration Tests
- End-to-end order fulfillment
- API error handling
- Database state after fulfillment

### Manual Tests
- AT-iShare test credentials
- Success scenarios
- Failure scenarios
- Retry scenarios

## Monitoring & Logging

**What to Monitor**:
- Fulfillment success rate (target: 99%+)
- Average fulfillment time
- Retry rates
- API error distribution

**Logging**:
- All API calls and responses
- Order status changes
- Retry attempts
- Errors with stack traces

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| AT-iShare API down | Orders fail | Retry logic, fallback notifications |
| Invalid phone numbers | Fulfillment fails | Phone validation before order |
| Duplicate fulfillment | Double charge | Check fulfillment status before retry |
| Rate limiting | API blocked | Implement rate limiting on our side |
| Data loss | Missing orders | Transaction logs, audit trail |

## Timeline Estimate

- Phase 1-2: 2-3 hours (Schema + Service)
- Phase 3-4: 2-3 hours (API + Integration)
- Phase 5-7: 3-4 hours (Status tracking + Notifications)
- Phase 8: 2-3 hours (Admin dashboard)
- Testing: 2-3 hours
- **Total: 13-19 hours** (can be phased)

## Next Steps

1. Confirm AT-iShare API documentation/credentials
2. Decide on fulfillment trigger (immediate vs. background job)
3. Get approval on retry strategy (max attempts, backoff timing)
4. Set up test environment with AT-iShare
5. Start Phase 1 implementation
