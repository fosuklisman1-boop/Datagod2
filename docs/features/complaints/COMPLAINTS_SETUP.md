# Complaint System Setup Guide

This document outlines the setup required for the new order-specific complaint system with evidence photo uploads.

## Overview

The complaint system allows customers to file complaints tied to specific orders and upload two pieces of evidence:
1. Data balance screenshot showing remaining data
2. MoMo receipt/payment proof

## Database Schema Update

Add the following fields to the `complaints` table in Supabase:

### SQL Migration

```sql
-- Add evidence and order_details columns (if not exists)
-- Skip order_id if it already exists
ALTER TABLE complaints
ADD COLUMN IF NOT EXISTS evidence JSONB DEFAULT NULL,
ADD COLUMN IF NOT EXISTS order_details JSONB DEFAULT NULL;

-- Update status column default (if not already set)
ALTER TABLE complaints
ALTER COLUMN status SET DEFAULT 'pending';

-- Create index for order_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_complaints_order_id ON complaints(order_id);
CREATE INDEX IF NOT EXISTS idx_complaints_user_id ON complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);

-- Update RLS policies (make sure these policies exist)
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own complaints" 
  ON complaints FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own complaints" 
  ON complaints FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all complaints" 
  ON complaints FOR SELECT 
  USING (auth.jwt() ->> 'email' = 'admin@example.com');
```

## Storage Bucket Setup

Create a new storage bucket in Supabase for complaint evidence files:

### Steps:

1. Go to Supabase Dashboard → Storage
2. Create a new bucket with the following settings:
   - **Name**: `complaint-evidence`
   - **Privacy**: Private (use signed URLs)
   - **File size limit**: 10 MB

### Storage Path Structure

Files are stored in the following structure:
```
complaint-evidence/
  {user_id}/
    {order_id}/
      balance-{timestamp}.jpg
      receipt-{timestamp}.jpg
```

### Bucket Policies

Add the following RLS policies to the bucket:

```sql
-- Users can upload to their own folder
CREATE POLICY "Users can upload their own evidence" 
  ON storage.objects 
  FOR INSERT 
  WITH CHECK (bucket_id = 'complaint-evidence' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Users can view their own evidence
CREATE POLICY "Users can view their own evidence" 
  ON storage.objects 
  FOR SELECT 
  USING (bucket_id = 'complaint-evidence' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Admins can view all evidence
CREATE POLICY "Admins can view all evidence" 
  ON storage.objects 
  FOR SELECT 
  USING (bucket_id = 'complaint-evidence');
```

## API Endpoint

The API endpoint `/api/complaints/create` handles:
- Form validation
- Image upload to Supabase Storage
- Complaint record creation with metadata
- Evidence URL storage (JSONB format)

### Request Format

```typescript
POST /api/complaints/create
Content-Type: multipart/form-data

- orderId: string (UUID)
- userId: string (UUID)
- description: string (min 10 chars)
- priority: "low" | "medium" | "high"
- orderDetails: JSON string with order metadata
- balanceImage: File (JPG/PNG/WebP, max 5MB)
- momoReceiptImage: File (JPG/PNG/WebP, max 5MB)
```

### Response Format

```json
{
  "message": "Complaint submitted successfully",
  "complaint": {
    "id": "uuid",
    "user_id": "uuid",
    "order_id": "uuid",
    "title": "Data Issue - MTN 5GB",
    "description": "...",
    "priority": "high",
    "status": "pending",
    "order_details": {
      "network": "MTN",
      "package": "5GB",
      "phone": "0501234567",
      "amount": 10.50,
      "date": "2024-01-15T10:30:00Z"
    },
    "evidence": {
      "balance_image_url": "https://...",
      "momo_receipt_url": "https://...",
      "balance_image_path": "...",
      "momo_receipt_path": "..."
    },
    "created_at": "2024-01-20T14:22:00Z",
    "updated_at": "2024-01-20T14:22:00Z"
  }
}
```

## Frontend Components

### ComplaintModal

Location: `components/complaint-modal.tsx`

Features:
- Order summary display
- Priority selection
- Description textarea with min length validation
- Dual image upload fields with preview
- File type and size validation
- Submit with loading state

Usage:
```tsx
import { ComplaintModal } from "@/components/complaint-modal"

<ComplaintModal
  isOpen={isOpen}
  onClose={() => setIsOpen(false)}
  orderId={order.id}
  orderDetails={{
    networkName: order.network_name,
    packageName: order.package_name,
    phoneNumber: order.phone_number,
    totalPrice: order.total_price,
    createdAt: order.created_at,
  }}
/>
```

### Integration in My Orders Page

Location: `app/dashboard/my-orders/page.tsx`

Features:
- "Complain" button (MessageSquare icon) on each order
- Opens modal with pre-filled order details
- Modal state management
- Form reset after submission

## Admin Dashboard

Location: `app/admin/complaints/page.tsx`

Features:
- View all customer complaints
- Filter by status, priority, date range
- Search complaints
- Complaint details modal with evidence images
- Resolution notes editor
- Status update functionality

### Displaying Evidence

The admin page needs to be updated to display the evidence images. Update the complaint details modal to show:
```tsx
<img src={complaint.evidence.balance_image_url} alt="Data balance evidence" />
<img src={complaint.evidence.momo_receipt_url} alt="MoMo receipt evidence" />
```

## Testing

### Test Complaint Submission

1. Navigate to Dashboard → My Orders
2. Click "Complain" button on any order
3. Fill in the complaint form:
   - Description (min 10 characters)
   - Priority level
   - Upload data balance screenshot
   - Upload MoMo receipt screenshot
4. Click Submit
5. Verify success toast message
6. Check admin complaints page to see the new complaint

### Test Image Upload

1. Try uploading files that are:
   - Too large (>5MB) - should be rejected
   - Wrong format (PDF, text) - should be rejected
   - Correct format (JPG, PNG, WebP) - should be accepted
2. Verify preview displays correctly
3. Verify images are accessible from admin page

## Environment Variables

Ensure these are set in `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## Troubleshooting

### Images not uploading
- Check bucket exists: `complaint-evidence`
- Check bucket privacy settings
- Verify user is authenticated
- Check browser console for CORS errors
- Check Supabase logs for storage errors

### Complaint not saving
- Check database schema includes order_id field
- Verify user_id is being sent correctly
- Check RLS policies on complaints table
- Review server logs for database errors

### Evidence not displaying in admin
- Verify image URLs are public
- Check storage bucket policies
- Ensure images were uploaded successfully
- Check for storage CDN/cache issues

## Future Enhancements

1. Email notifications when complaints are filed/resolved
2. Complaint status tracking with notifications
3. Auto-resolution for common issues
4. Image compression before upload
5. Complaint history and analytics
6. Customer-admin chat for complaint discussion
7. Automatic refund for specific complaint types
