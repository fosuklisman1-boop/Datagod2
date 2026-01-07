# MTN API Integration Plan for Order Fulfillment

## API Analysis Summary

### Base Information
- **Base URL**: https://sykesofficial.net
- **API Token**: fe1c1c505a3d8fecd4ce794113bebe9d3849b3f611fb1745
- **Authentication**: X-API-KEY header (recommended)
- **Response Format**: JSON
- **Rate Limiting**: None (unlimited access)

### Available Endpoints

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/api/orders` | POST | Create data order | ✅ Primary |
| `/api/orders` | GET | Get order history | ℹ️ Reference |
| `/api/balance` | GET | Check wallet balance | ✅ Pre-check |
| `/api/deposit` | POST | Add funds | ℹ️ Admin only |

### Phone Number Support
**Valid Formats**:
- `0241234567` (10 digits with 0 prefix)
- `241234567` (9 digits, auto-add 0)
- `233241234567` (with country code)

**Invalid Formats** (will reject):
- `+233241234567` (plus sign)
- `024-123-4567` (dashes)
- `024 123 4567` (spaces)

### Network Validation
**MTN** (Our primary network):
- Valid prefixes: 024, 025, 053, 054, 055, 059
- Example: 0241234567, 0251234567

**Telecel**:
- Valid prefixes: 020, 050

**AirtelTigo**:
- Valid prefixes: 026, 027, 056, 057

### Order Creation Request
```json
{
  "recipient_phone": "0241234567",
  "network": "MTN",
  "size_gb": 5
}
```

### Order Creation Response
**Success** (HTTP 200):
```json
{
  "success": true,
  "order_id": 123,
  "message": "Order created successfully"
}
```

**Error** (HTTP 400-500):
```json
{
  "success": false,
  "message": "Insufficient balance"
}
```

### Error Codes
| HTTP | Error | Description | Solution |
|------|-------|-------------|----------|
| 401 | Invalid API key | Missing/incorrect token | Verify X-API-KEY header |
| 402 | Insufficient balance | Not enough funds | Check balance first |
| 404 | Plan not found | Invalid data_plan_id | Use network + size_gb |
| 400 | Invalid parameters | Missing/bad data | Validate inputs |
| 500 | Server error | MTN API issue | Retry with backoff |

### Webhooks
**Event**: `order.status_changed`
**Payload**:
```json
{
  "event": "order.status_changed",
  "timestamp": "2024-01-15T10:30:00Z",
  "order": {
    "id": 123,
    "status": "completed|failed|pending",
    "message": "Order processed successfully",
    "amount": 25.00,
    "recipient_phone": "0241234567",
    "plan_name": "MTN 5GB",
    "network": "MTN",
    "size_mb": 5120,
    "created_at": "2024-01-15 10:25:00",
    "updated_at": "2024-01-15 10:30:00"
  }
}
```

**Security**: Includes X-Webhook-Signature header (SHA256 HMAC)

---

## Integration Architecture

### System Flow

```
Shop Order (MTN)
    ↓
Check: Is MTN Auto-Fulfillment ENABLED?
    ↓
  [YES] → Auto-Fulfill via MTN API          [NO] → Queue for Admin Download
    ↓                                              ↓
Pre-Fulfillment Checks:                    Add to shop_orders with
  ✓ Phone number validation                 status: 'pending_download'
  ✓ Balance check (sufficient funds)        (Admin downloads + fulfills manually)
  ✓ Data size availability
    ↓
MTN API Request
  POST /api/orders
  {recipient_phone, network, size_gb}
    ↓
Responses:
  ✅ Success → Store MTN order_id, await webhook
  ❌ Failed → Log error, mark as failed, retry
    ↓
Webhook Received
  POST /api/webhook/mtn
  {event, order, status}
    ↓
Update Order Status
  → fulfillment_logs table
  → shop_orders table
  → Send notification to customer
```

### Admin Control Panel

```
MTN Auto-Fulfillment Settings
┌─────────────────────────────────────┐
│ Enable MTN Auto-Fulfillment         │
│                                     │
│ Status: [🔵 ON] [⚪ OFF]           │
│                                     │
│ When OFF:                           │
│ • MTN orders go to Downloads tab    │
│ • Admin manually triggers fulfillment
│ • Manual control over each order    │
│                                     │
│ When ON:                            │
│ • Orders auto-fulfill immediately   │
│ • Tracked in MTN Fulfillment tab    │
│ • Faster customer delivery          │
│                                     │
│ Last Updated: 2024-01-05 14:30     │
└─────────────────────────────────────┘
```

### Database Schema Changes Needed

#### New Table: `mtn_fulfillment_tracking`
```sql
CREATE TABLE mtn_fulfillment_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_order_id UUID NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  mtn_order_id INTEGER NOT NULL UNIQUE,
  api_request_payload JSONB,
  api_response_payload JSONB,
  webhook_payload JSONB,
  status VARCHAR(50) DEFAULT 'pending', -- pending, completed, failed
  recipient_phone VARCHAR(20),
  network VARCHAR(20),
  size_gb INTEGER,
  external_status VARCHAR(50),
  external_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  webhook_received_at TIMESTAMP,
  CONSTRAINT valid_status CHECK (status IN ('pending', 'completed', 'failed', 'error'))
);

CREATE INDEX idx_mtn_fulfillment_shop_order_id ON mtn_fulfillment_tracking(shop_order_id);
CREATE INDEX idx_mtn_fulfillment_mtn_order_id ON mtn_fulfillment_tracking(mtn_order_id);
CREATE INDEX idx_mtn_fulfillment_status ON mtn_fulfillment_tracking(status);
```

#### Update: `app_settings` table
Add new setting for MTN auto-fulfillment:
```sql
INSERT INTO app_settings (key, value, description, updated_at)
VALUES (
  'mtn_auto_fulfillment_enabled',
  'false',
  'Enable/disable automatic fulfillment of MTN orders via MTN API',
  NOW()
);
```

#### Update: `shop_orders` table
Add column to track fulfillment method:
```sql
ALTER TABLE shop_orders 
ADD COLUMN fulfillment_method VARCHAR(50) DEFAULT 'manual', -- 'manual', 'auto_mtn'
ADD COLUMN external_order_id INTEGER REFERENCES mtn_fulfillment_tracking(mtn_order_id);
```

### Code Structure

```
lib/
  mtn-fulfillment.ts          ← Main service
    • isAutoFulfillmentEnabled()  ← Check if MTN auto-fulfill is ON
    • validatePhoneNumber()
    • validateBalance()
    • createOrder()
    • formatPhoneNumber()
    • handleError()

app/api/
  admin/
    settings/
      mtn-auto-fulfillment/
        route.ts              ← Get/update auto-fulfillment setting
          • GET: Return current status
          • POST: Toggle on/off
    
    fulfillment/
      webhook/
        mtn/
          route.ts            ← Webhook receiver
            • Verify signature
            • Update order status
            • Send notifications
      
      mtn-balance/
        route.ts              ← Check MTN balance (admin only)

  fulfillment/
    process-order/
      route.ts                ← Main order processing
        • Check MTN auto-fulfillment setting
        • Route to auto-fulfill OR manual download
```

---

## Implementation Steps

### Phase 1: Settings & Toggle UI (Week 1)
- [ ] Add `mtn_auto_fulfillment_enabled` to app_settings
- [ ] Create admin settings endpoint (GET/POST)
- [ ] Build toggle UI in admin settings page
- [ ] Test on/off switching

### Phase 2: Core Integration (Week 1-2)
- [ ] Create `lib/mtn-fulfillment.ts` service
- [ ] Add phone validation logic
- [ ] Implement MTN API client
- [ ] Create `mtn_fulfillment_tracking` table
- [ ] Add webhook endpoint `/api/webhook/mtn`

### Phase 3: Order Routing (Week 2)
- [ ] Update order processing to check auto-fulfillment setting
- [ ] Route to auto-fulfill if ON
- [ ] Route to manual download if OFF
- [ ] Add fulfillment_method tracking to shop_orders

### Phase 4: Order Flow (Week 2-3)
- [ ] Integrate into fulfillment service
- [ ] Add balance pre-check
- [ ] Implement retry logic with exponential backoff
- [ ] Add error logging and recovery

### Phase 5: Admin Features (Week 3)
- [ ] Dashboard showing MTN fulfillment status
- [ ] Manual order creation/retry
- [ ] Balance monitoring
- [ ] Error tracking and analysis
- [ ] View/manage both auto and manual fulfillment

### Phase 6: Testing & Deployment (Week 4)
- [ ] Unit tests for phone validation
- [ ] Integration tests with MTN API
- [ ] Webhook signature verification tests
- [ ] Load testing
- [ ] Production deployment with monitoring

---

## Security Considerations

### API Token Storage
```typescript
// ✅ DO: Use environment variables
const MTN_API_KEY = process.env.MTN_API_KEY

// ❌ DON'T: Hard-code tokens
const MTN_API_KEY = "fe1c1c505a3d8fecd4ce794113bebe9d3849b3f611fb1745"
```

### Webhook Signature Verification
```typescript
// Verify incoming webhooks
const expectedSignature = crypto
  .createHmac("sha256", MTN_API_KEY)
  .update(JSON.stringify(req.body))
  .digest("hex")

if (req.headers["x-webhook-signature"] !== `sha256=${expectedSignature}`) {
  return res.status(401).json({ error: "Invalid signature" })
}
```

### Data Protection
- Store full API requests/responses in DB for audit trail
- Mask sensitive phone numbers in logs
- Encrypt MTN order IDs in transit
- Never log API token in production

---

## Error Handling Strategy

### Retry Logic
```
Attempt 1: Immediate
  ↓ [5min delay if failed]
Attempt 2: After 5 minutes
  ↓ [15min delay if failed]
Attempt 3: After 15 minutes
  ↓ [1hour delay if failed]
Attempt 4: After 1 hour
  ↓ [Manual intervention needed]
Manual Review: Admin dashboard alert
```

### Error Categories

| Error | Handling | Retry | Action |
|-------|----------|-------|--------|
| Invalid phone | Log & mark failed | No | Customer support |
| Insufficient balance | Log & pause | Manual | Admin top-up |
| Network mismatch | Log & mark failed | No | Customer support |
| API timeout | Log & queue | Yes (exponential) | Auto-retry |
| Invalid API key | Alert admin | No | Check credentials |
| Webhook not received | Monitor | Yes (webhook retry) | Fallback to polling |

---

## Monitoring & Analytics

### Metrics to Track
- Total orders submitted
- Success rate (%)
- Average fulfillment time
- Failed orders by error type
- API response times
- Webhook delivery success rate
- Balance utilization

### Alerts
- MTN API unavailable (status != 200)
- Balance drops below threshold (e.g., ₵500)
- High failure rate (>5% in 1 hour)
- Webhook delivery failures (>10%)
- Orders stuck in pending (>30min)

### Dashboard Requirements
- MTN fulfillment status (pending, completed, failed)
- Real-time order tracking
- Balance display
- Error logs with retry options
- Performance metrics (last 24h, 7d, 30d)

---

## Testing Plan

### Unit Tests
```typescript
// Phone number validation
✓ Valid: 0241234567, 241234567, 233241234567
✓ Invalid: +233241234567, 024-123-4567
✓ Network matching: MTN with valid prefixes

// API request building
✓ Correct headers (X-API-KEY)
✓ Correct payload format
✓ Timeout handling
```

### Integration Tests
```typescript
// Create order flow
✓ Valid order → MTN API → Success response
✓ Insufficient balance → API returns 402
✓ Invalid phone → API returns 400

// Webhook flow
✓ Receive webhook → Verify signature → Update DB
✓ Invalid signature → Reject request
✓ Duplicate webhook → Idempotent update
```

### Load Testing
- 1000 concurrent orders
- Webhook delivery under load
- Database connection pooling

---

## Configuration

### Environment Variables Required
```env
# MTN API
MTN_API_KEY=fe1c1c505a3d8fecd4ce794113bebe9d3849b3f611fb1745
MTN_API_BASE_URL=https://sykesofficial.net
MTN_WEBHOOK_SECRET=<signature key>

# Fulfillment Settings
MTN_AUTO_FULFILLMENT_DEFAULT=false  # Default setting when app starts
MTN_AUTO_FULFILL_TIMEOUT_MS=30000   # Timeout for auto-fulfillment request

# Retry & Recovery
MTN_RETRY_MAX_ATTEMPTS=4
MTN_RETRY_BACKOFF_MS=5000
MTN_REQUEST_TIMEOUT_MS=30000

# Monitoring
MTN_BALANCE_ALERT_THRESHOLD=500
MTN_FAILURE_RATE_ALERT_THRESHOLD=5
MTN_WEBHOOK_DELIVERY_TIMEOUT_MS=60000
```

---

## Implementation Priority

### 🔴 Critical (Do First)
1. Add MTN auto-fulfillment setting to app_settings
2. Create admin settings toggle UI
3. Phone number validation
4. MTN API client with error handling
5. Order routing logic (check setting, auto vs manual)

### 🟡 Important (Do Second)
1. Webhook receiver with signature verification
2. Order status tracking in DB
3. Balance pre-check
4. Retry logic
5. Error logging

### 🟢 Nice-to-Have (Do Last)
1. Admin dashboard features
2. Analytics & monitoring
3. Automated top-ups
4. Advanced retry strategies

---

## Next Steps

1. **Review this plan** with team
2. **Create migrations** for new tables
3. **Build MTN service** (`lib/mtn-fulfillment.ts`)
4. **Implement webhook** receiver
5. **Integrate** into existing fulfillment flow
6. **Test** with sandbox/test API first
7. **Deploy** with monitoring

---

## Notes

- **Webhook Configuration**: Still needs to be set up in MTN dashboard with our webhook URL
- **API Token Security**: Currently exposed in this doc - will be moved to environment variables
- **Balance Management**: Consider implementing automatic top-ups or low-balance alerts
- **Logging**: All API calls should be logged for debugging and compliance
- **Rate Limiting**: None from API, but implement client-side throttling to avoid overwhelming
