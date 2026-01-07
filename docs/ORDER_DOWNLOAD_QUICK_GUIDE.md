# Order Download System - Quick Reference Guide

## 🎯 Feature Overview

The Order Download Management System enables admins to:
- **Download** pending orders in bulk
- **Export** orders as CSV file
- **Track** downloaded batches by network and time
- **Manage** order status automatically

## 🚀 Quick Start

### Step 1: Database Setup
Run this SQL in Supabase:
```sql
-- Execute from: lib/create-order-download-batches.sql
```

### Step 2: Access the Feature
Navigate to: **Admin Panel → Order Management**
Or directly: `/admin/orders`

### Step 3: Download Orders
1. Click **"Pending Orders"** tab
2. Review the list of pending orders
3. Click **"Download All"** button
4. CSV file downloads automatically
5. Orders move to **"Downloaded"** tab

## 📊 User Interface

### Two Main Tabs

#### 🕐 Pending Orders Tab
```
┌──────────────────────────────────────────────┐
│ Pending (25)                [Download All ▼] │
├──────────────────────────────────────────────┤
│ Ref Code │ Network   │ Customer │ Phone │... │
├──────────────────────────────────────────────┤
│ ORD-001  │ MTN 🟠    │ John     │ 0201... │  │
│ ORD-002  │ Telecel 🔴│ Jane     │ 0551... │  │
│ ORD-003  │ AT 🔵     │ Bob      │ 0242... │  │
└──────────────────────────────────────────────┘
```

#### 📦 Downloaded Tab
```
┌─────────────────────────────────────────────┐
│ MTN (22 orders)                              │
│ Downloaded: Nov 26, 2025 10:30 AM           │
├─────────────────────────────────────────────┤
│ Ref Code │ Customer │ Phone │ Volume │ Price│
├─────────────────────────────────────────────┤
│ ORD-001  │ John     │ 0201..│ 1GB    │ GHS 6│
│ ORD-004  │ Alice    │ 0201..│ 2GB    │ GHS10│
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Telecel (3 orders)                           │
│ Downloaded: Nov 26, 2025 10:30 AM           │
├─────────────────────────────────────────────┤
│ Ref Code │ Customer │ Phone │ Volume │ Price│
├─────────────────────────────────────────────┤
│ ORD-002  │ Jane     │ 0551..│ 5GB    │ GHS19│
└─────────────────────────────────────────────┘
```

## 🔄 What Happens When You Download

```
Before Download:
┌─────────────────────────────┐
│ Database Status             │
├─────────────────────────────┤
│ Pending Orders: 25          │
│ Order Status: "pending"     │
│ Downloaded Batches: 0       │
└─────────────────────────────┘

Click "Download All"
        ↓
        ↓ (Backend Processing)
        ↓
        1️⃣ Fetch all 25 pending orders
        2️⃣ Update status: "pending" → "processing"
        3️⃣ Group by network (MTN: 22, Telecel: 3)
        4️⃣ Create batch record with timestamp
        5️⃣ Generate CSV file
        6️⃣ Download to browser
        ↓

After Download:
┌─────────────────────────────┐
│ Database Status             │
├─────────────────────────────┤
│ Pending Orders: 0           │
│ Order Status: "processing"  │
│ Downloaded Batches: 1       │
│ - MTN (22 orders)           │
│ - Telecel (3 orders)        │
└─────────────────────────────┘
```

## 📄 CSV File Details

**File Name**: `orders-2025-11-26.csv`

**Contains All Orders With**:
- ✅ Reference Code
- ✅ Customer Details (Name, Email, Phone)
- ✅ Network Type
- ✅ Data Volume
- ✅ Pricing (Base, Profit, Total)
- ✅ Order & Payment Status
- ✅ Creation Date

**Ready for**: Fulfillment, Payment Processing, Record Keeping

## 🌐 Network Color Coding

| Network | Color | Badge |
|---------|-------|-------|
| MTN | Orange | 🟠 |
| Telecel | Red | 🔴 |
| AT | Blue | 🔵 |
| AT - iShare | Indigo | 🟣 |
| AT - BigTime | Purple | 🟣 |
| iShare | Green | 🟢 |

## 🎮 Navigation

### From Admin Dashboard
```
Admin Dashboard
    ↓
Order Management Card
    ↓
Orders Page (/admin/orders)
```

### From Sidebar
```
Sidebar
    ↓
ADMIN Section
    ↓
Orders Link
    ↓
Orders Page (/admin/orders)
```

### Direct URL
```
https://yourdomain.com/admin/orders
```

## ⚡ Common Tasks

### Task: View Pending Orders
1. Go to `/admin/orders`
2. Stay on "Pending Orders" tab
3. Scroll through the table

### Task: Download All Pending Orders
1. Go to `/admin/orders`
2. Click "Download All" button
3. Wait for file to download
4. Check Downloads folder

### Task: View Downloaded Batches
1. Go to `/admin/orders`
2. Click "Downloaded" tab
3. Each batch shows network and time
4. Click batch to expand order list

### Task: Check Order in a Batch
1. Go to "Downloaded" tab
2. Find the batch
3. Look for the order in the table
4. Status shows as "Processing"

### Task: Export to Spreadsheet
1. Download CSV file
2. Open in Excel/Google Sheets
3. Use for reporting/analysis

## 📋 Order Status Lifecycle

```
Order Created
    ↓ (order_status: "pending")
    ↓
Admin Views Pending Orders
    ↓
Admin Clicks "Download All"
    ↓ (order_status: "processing")
    ↓
Order in Downloaded Batch
    ↓
Fulfillment/Payment Processing
    ↓ (order_status: "completed" or "failed")
    ↓
Order Removed from Download System
```

## 🔐 Requirements

### To Use This Feature:
✅ Must have **admin role** set
✅ Access `/admin/orders`
✅ Verify in database: `order_download_batches` table exists

### To Set Admin Role:
1. Go to `/admin-setup`
2. Click "Make yourself admin"
3. Refresh page

## 🚨 Important Notes

⚠️ **Orders can only be downloaded once**
- Once downloaded, status changes to "processing"
- They won't appear in Pending tab again
- They appear in Downloaded tab with timestamp

⚠️ **CSV Download Required**
- Make sure popup blockers are disabled
- File downloads to your Downloads folder
- Keep for your records

⚠️ **Admin Role Required**
- Only admins can access `/admin/orders`
- Contact admin if you need access

## 💡 Tips & Tricks

**Tip 1**: Download at regular intervals
- Set a schedule to download pending orders
- Keeps system clean and organized

**Tip 2**: Archive CSV files
- Save downloaded CSV files for audit trail
- Create folder: Downloads/Orders/2025-11/

**Tip 3**: Check batch timestamps
- Downloaded tab shows when batch was processed
- Useful for tracking order flow

**Tip 4**: Use network grouping
- Orders grouped by network for easier processing
- Process one network type at a time

**Tip 5**: Monitor order count
- Tab label shows pending order count
- Quick indicator of workload

## ⚙️ Technical Details

**Backend Endpoint**:
```
POST /api/admin/orders/download
```

**Database Table**:
```
order_download_batches
- Stores batch records
- Groups orders by network & time
- Indexed for fast queries
```

**Service Used**:
```typescript
adminOrderService.downloadPendingOrders(orderIds)
```

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| Page won't load | Check admin role at `/admin-setup` |
| No pending orders | Create test orders in database |
| Download button disabled | Must have pending orders |
| CSV not downloading | Check popup blocker settings |
| Downloaded tab empty | Refresh page after download |
| Network colors wrong | Clear browser cache |

## 📞 Need Help?

1. **Quick Questions**: Check ORDER_DOWNLOAD_SETUP.md
2. **Technical Details**: See ORDER_DOWNLOAD_SYSTEM.md
3. **Architecture**: Review ORDER_DOWNLOAD_IMPLEMENTATION.md
4. **Code Issues**: Check browser console (F12)
5. **Database Issues**: Check Supabase SQL logs

## ✨ What's New

✨ **Pending Orders Tab**
- Clean interface for viewing orders
- Easy to download all at once

✨ **Batch Grouping**
- Orders organized by network
- Timestamp shows when processed

✨ **CSV Export**
- Ready for spreadsheet import
- Contains all necessary details

✨ **Automatic Status**
- No manual updates needed
- Status changes automatically

✨ **Sidebar Integration**
- Quick access from navigation
- Added to admin section

---

**Version**: 1.0
**Status**: ✅ Live and Ready
**Last Updated**: November 26, 2025
