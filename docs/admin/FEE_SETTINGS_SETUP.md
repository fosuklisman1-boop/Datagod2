# Fee Settings Configuration

## Overview
This update adds the ability to configure payment fees through the admin settings interface.

## What Changed
1. **New Table Columns** in `app_settings`:
   - `paystack_fee_percentage` (DECIMAL, default 3.0)
   - `wallet_topup_fee_percentage` (DECIMAL, default 0.0)
   - `announcement_enabled` (BOOLEAN, default false)
   - `announcement_title` (VARCHAR)
   - `announcement_message` (TEXT)

2. **New API Endpoint**:
   - `GET /api/settings/fees` - Public endpoint to fetch current fees

3. **Updated Endpoints**:
   - `PUT /api/admin/settings` - Now accepts fee percentage fields
   - `POST /api/payments/initialize` - Now uses configurable fees from settings

## Database Migration
Run this SQL in Supabase to add the new columns:

```sql
ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS announcement_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS announcement_title VARCHAR(255),
ADD COLUMN IF NOT EXISTS announcement_message TEXT,
ADD COLUMN IF NOT EXISTS paystack_fee_percentage DECIMAL(5,2) DEFAULT 3.0,
ADD COLUMN IF NOT EXISTS wallet_topup_fee_percentage DECIMAL(5,2) DEFAULT 0.0;
```

**Location**: `migrations/add_app_settings_columns.sql`

## How to Use

### As Admin
Update fees via the settings API:

```bash
curl -X PUT http://localhost:3000/api/admin/settings \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "join_community_link": "https://example.com",
    "paystack_fee_percentage": 2.5,
    "wallet_topup_fee_percentage": 1.0
  }'
```

### As Developer
Fetch current fees in your code:

```javascript
const response = await fetch('/api/settings/fees')
const { paystack_fee_percentage, wallet_topup_fee_percentage } = await response.json()
```

## Fee Ranges
- **Paystack Fee**: 0 to 100 (percentage)
- **Wallet Topup Fee**: 0 to 100 (percentage)

## Default Values
- **Paystack Fee**: 3.0% (matches Paystack's standard rate)
- **Wallet Topup Fee**: 0% (no additional fee)

## Safety
- Fees are validated to be between 0-100%
- If settings are missing, safe defaults are returned
- Database constraints ensure data integrity
