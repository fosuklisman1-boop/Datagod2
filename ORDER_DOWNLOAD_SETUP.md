# Order Download System - Setup Guide

## Quick Start

### Step 1: Run Database Migration

Copy and run this SQL in Supabase SQL Editor:

```sql
-- Create order_download_batches table to track downloaded orders
CREATE TABLE IF NOT EXISTS order_download_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network VARCHAR(50) NOT NULL,
  batch_time TIMESTAMP NOT NULL,
  orders JSONB NOT NULL DEFAULT '[]'::jsonb,
  order_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_order_download_batches_network ON order_download_batches(network);
CREATE INDEX IF NOT EXISTS idx_order_download_batches_batch_time ON order_download_batches(batch_time);

-- Enable RLS
ALTER TABLE order_download_batches ENABLE ROW LEVEL SECURITY;

-- Admin read policy
CREATE POLICY "Admin can read batch records"
  ON order_download_batches FOR SELECT
  USING (true);
```

### Step 2: Access the Feature

1. Go to Admin Panel: `/admin`
2. Click "Order Management" card
3. Or use sidebar: ADMIN → Orders

### Step 3: Download Orders

1. Go to "Pending Orders" tab
2. Review pending orders
3. Click "Download All" button
4. CSV file will download automatically
5. Orders move to "Downloaded" tab

## What Happens on Download

✅ All pending orders are fetched  
✅ Status changes from "pending" to "processing"  
✅ Orders grouped by network  
✅ Batch record created with timestamp  
✅ CSV file generated and downloaded  
✅ Orders move to Downloaded tab  

## CSV File Contents

File name: `orders-YYYY-MM-DD.csv`

Columns included:
- Reference Code
- Customer Name
- Customer Email
- Customer Phone
- Network
- Volume (GB)
- Base Price
- Profit Amount
- Total Price
- Order Status
- Payment Status
- Created Date

## Tabs Overview

### Pending Orders Tab
- Shows count of pending orders
- Download button to get all orders
- Table view of all pending orders

### Downloaded Orders Tab
- Shows batches grouped by network and time
- Each batch is collapsible
- Timestamp shows when batch was downloaded

## File Locations

| File | Purpose |
|------|---------|
| `/app/admin/orders/page.tsx` | Main orders management page |
| `/app/api/admin/orders/download/route.ts` | Download API endpoint |
| `/lib/admin-service.ts` | Order service functions |
| `/lib/create-order-download-batches.sql` | Database migration |

## Verify Installation

1. ✅ Check `/admin/orders` page loads
2. ✅ Check "Pending Orders" tab shows orders
3. ✅ Check "Download All" button is visible
4. ✅ Check sidebar has "Orders" link under ADMIN

## Troubleshooting

**Problem**: Orders page won't load
- Solution: Verify admin role is set for your user
- Check: Go to `/admin-setup` to set admin role

**Problem**: No pending orders showing
- Solution: Create test orders in database first
- Check: SQL query in admin service

**Problem**: Download button not working
- Solution: Check browser console for errors
- Check: Network tab to see API response

**Problem**: CSV file not downloading
- Solution: Check browser popup blocker
- Check: File size in API response

## Environment Check

Ensure these are in `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=your_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

The service role key is needed for:
- Creating batch records
- Updating order statuses
- Accessing admin APIs

## Next Steps

After setting up:
1. Test with sample orders
2. Verify CSV format matches your requirements
3. Set up order processing workflow
4. Configure fulfillment system
5. Monitor download batches

## Support

For detailed documentation, see: `ORDER_DOWNLOAD_SYSTEM.md`
