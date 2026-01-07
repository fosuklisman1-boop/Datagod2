# Order Download Management System - Admin Feature

## Overview

The Order Download Management System is a comprehensive feature that allows admins to efficiently manage and download pending orders. Orders are automatically grouped by network and download time, with status automatically transitioning to "processing" upon download.

## Features

### 1. **Pending Orders Tab**
- Display all pending orders in a clean table format
- Sort by network, customer, date, and amount
- One-click download of all pending orders
- Status automatically changes to "processing" after download

### 2. **Downloaded Orders Tab**
- View all previously downloaded orders organized in batches
- Batches are grouped by:
  - **Network**: Orders are segregated by network (MTN, Telecel, AT, etc.)
  - **Download Time**: Orders downloaded at the same time are grouped together
- Each batch shows:
  - Network name (color-coded)
  - Download timestamp
  - Order count
  - Detailed order information table

### 3. **CSV Export**
- Download all pending orders as a CSV file
- Includes comprehensive order details:
  - Reference Code
  - Customer Name & Email
  - Customer Phone
  - Network
  - Volume (GB)
  - Pricing (Base Price, Profit, Total)
  - Order & Payment Status
  - Created Date

### 4. **Automatic Status Management**
- Orders status automatically updates to "processing" when downloaded
- Prevents duplicate downloads of the same orders
- Batch tracking ensures audit trail of all downloads

## Database Schema

### `order_download_batches` Table

```sql
CREATE TABLE order_download_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network VARCHAR(50) NOT NULL,
  batch_time TIMESTAMP NOT NULL,
  orders JSONB NOT NULL DEFAULT '[]'::jsonb,
  order_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Indexes:**
- `idx_order_download_batches_network` - Fast queries by network
- `idx_order_download_batches_batch_time` - Fast queries by download time

## API Endpoints

### POST `/api/admin/orders/download`

**Purpose**: Download pending orders and update their status

**Request Body:**
```json
{
  "orderIds": ["uuid1", "uuid2", "uuid3"]
}
```

**Response:**
```json
{
  "success": true,
  "count": 50,
  "csv": "Reference Code,Customer Name,Customer Email,..."
}
```

**What It Does:**
1. Fetches all requested orders from database
2. Updates order status to "processing"
3. Groups orders by network
4. Creates batch records in `order_download_batches` table
5. Generates CSV file with order details
6. Returns CSV for browser download

**Error Handling:**
- Returns 400 if no order IDs provided
- Returns 404 if orders not found
- Returns 500 on database errors
- Provides descriptive error messages

## Pages

### `/admin/orders` - Order Management Page

**Tabs:**

#### Pending Orders Tab
- Shows all orders with `order_status = "pending"`
- Displays order count in tab label
- One-click download button
- Table columns:
  - Reference Code
  - Network (color-coded badge)
  - Customer Name
  - Phone Number
  - Volume
  - Total Price
  - Date Created

**Actions:**
- `Download All` - Downloads CSV and updates order statuses

#### Downloaded Orders Tab
- Shows batches organized by network and download time
- Each batch is a separate card with:
  - Network badge
  - Download timestamp
  - Order count badge
  - Detailed orders table
- Batches sorted by newest first

**Order Details Table:**
- Reference Code
- Customer Name
- Phone Number
- Volume (GB)
- Total Price
- Status badge (Processing)

## Service Layer

### `adminOrderService` (in `/lib/admin-service.ts`)

```typescript
// Get pending orders
getPendingOrders(): Promise<ShopOrder[]>

// Get orders by status
getOrdersByStatus(status: string): Promise<ShopOrder[]>

// Download orders (calls API)
downloadPendingOrders(orderIds: string[]): Promise<{csv, count}>

// Get download batches
getDownloadBatches(): Promise<DownloadBatch[]>

// Get batches by network
getDownloadBatchesByNetwork(network: string): Promise<DownloadBatch[]>

// Update order status
updateOrderStatus(orderId: string, status: string): Promise<ShopOrder>

// Get order statistics
getOrderStats(): Promise<{pending, processing, completed, failed}>
```

## Workflow

1. **Admin Visits Orders Page**
   - Page loads pending orders
   - Page loads previously downloaded batches
   - Stats shown for reference

2. **Admin Downloads Orders**
   - Clicks "Download All" button
   - API processes:
     - Fetches all pending orders
     - Updates each order status to "processing"
     - Groups by network
     - Creates batch record
     - Generates CSV
   - Browser receives CSV file for download
   - Orders disappear from "Pending" tab
   - New batch appears in "Downloaded" tab

3. **CSV File Structure**
   - Filename: `orders-YYYY-MM-DD.csv`
   - Includes all order details
   - Ready for processing/fulfillment

## Color Coding

Networks are color-coded for quick identification:

| Network | Color |
|---------|-------|
| MTN | Orange |
| Telecel | Red |
| AT | Blue |
| AT - iShare | Indigo |
| AT - BigTime | Purple |
| iShare | Green |

## User Interface

### Admin Dashboard
- New "Order Management" card linking to `/admin/orders`
- Shows quick access to order management

### Sidebar Navigation
- New "Orders" link under ADMIN section
- Uses Download icon for quick recognition
- Highlighted when on orders page

## Installation

### 1. Run Database Migration

Execute in Supabase SQL Editor:

```bash
-- Run lib/create-order-download-batches.sql
```

Or manually create the table using the schema above.

### 2. File Structure

All new files created:
- `/app/admin/orders/page.tsx` - Main orders page
- `/app/api/admin/orders/download/route.ts` - Download API endpoint
- `/lib/create-order-download-batches.sql` - Database migration
- Updates to `/lib/admin-service.ts` - New service functions
- Updates to `/app/admin/page.tsx` - Added orders card
- Updates to `/components/layout/sidebar.tsx` - Added orders link

### 3. Environment Variables

Ensure these are set in `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
```

## Security

- ✅ Admin role check on orders page
- ✅ Service role key used for API operations
- ✅ RLS policies on database tables
- ✅ Error messages don't leak sensitive info
- ✅ Status updates prevent duplicate downloads

## Performance

- **Batch grouping**: Orders organized by network for efficient fulfillment
- **Indexed queries**: Fast lookups by network and timestamp
- **CSV generation**: Efficient string building
- **Lazy loading**: Downloaded batches loaded on demand

## Future Enhancements

- [ ] Batch retry if download fails
- [ ] Export completed orders
- [ ] Order search and filtering
- [ ] Batch status tracking (pending fulfillment, completed, failed)
- [ ] Email notifications on new orders
- [ ] Automated order processing workflows
- [ ] Integration with payment processors

## Testing Checklist

- [ ] Admin can view pending orders
- [ ] Download button visible and functional
- [ ] CSV file downloads correctly
- [ ] Order status changes to "processing" after download
- [ ] Downloaded batches appear in Downloaded tab
- [ ] Batches are grouped by network correctly
- [ ] Batch timestamps are accurate
- [ ] Network color coding displays correctly
- [ ] No pending orders shown in Pending tab after download
- [ ] Pagination works with large datasets

## Troubleshooting

### Orders not showing in Pending tab
- Check if orders exist with `order_status = "pending"`
- Verify database connection
- Check browser console for errors

### Download button not working
- Verify admin role is set
- Check API endpoint in Network tab
- Review backend console for errors

### Batches not appearing in Downloaded tab
- Verify `order_download_batches` table exists
- Check database permissions
- Ensure service role key is valid

### CSV file empty
- Verify orders were fetched successfully
- Check order data format
- Review API response in Network tab

## Code Examples

### Using the Service
```typescript
// In a component
import { adminOrderService } from "@/lib/admin-service"

// Get pending orders
const orders = await adminOrderService.getPendingOrders()

// Download orders
const result = await adminOrderService.downloadPendingOrders(orderIds)
const csv = result.csv

// Get order stats
const stats = await adminOrderService.getOrderStats()
console.log(stats) // { pending: 5, processing: 20, completed: 100, failed: 2 }
```

### Manual Status Update
```typescript
// Update a single order status
await adminOrderService.updateOrderStatus(orderId, "completed")
```

## Support

For issues or questions about the Order Download Management System:
1. Check the Troubleshooting section
2. Review the code comments
3. Check database logs
4. Review API endpoint responses
