# Order-Specific Complaint System - Architecture & Flow Diagrams

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATAGOD APPLICATION                         │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────────┐         ┌──────────────────────┐
│   CUSTOMER SIDE      │         │    ADMIN SIDE        │
├──────────────────────┤         ├──────────────────────┤
│  Dashboard           │         │  Admin Dashboard     │
│    └─ My Orders      │         │    └─ Complaints    │
│       ├─ View        │         │       ├─ View All   │
│       └─ Complain ◄──┼─────────┼──────► Resolve     │
│         (Button)     │         │       └─ See Images │
│                      │         │                      │
└──────────────────────┘         └──────────────────────┘
         │                                  ▲
         │ 1. Click Complain               │
         ▼                                  │
┌─────────────────────────────────────┐   │
│   ComplaintModal Component          │   │ 2. View
├─────────────────────────────────────┤   │    Complaints
│  ✓ Order Summary (auto-filled)      │   │
│  ✓ Description (min 10 chars)       │   │
│  ✓ Priority (Low/Med/High)          │   │
│  ✓ Balance Screenshot Upload        │   │
│  ✓ MoMo Receipt Screenshot Upload   │   │
│  ✓ Image Preview                    │   │
│  ✓ Submit Button                    │   │
└─────────────────────────────────────┘   │
         │                                  │
         │ 3. Submit FormData               │
         ▼                                  │
┌────────────────────────────────────────────────┐
│  Backend: POST /api/complaints/create          │
├────────────────────────────────────────────────┤
│  1. Parse FormData (text + 2 files)            │
│  2. Validate all fields                        │
│  3. Upload balance image to Storage            │
│  4. Upload receipt image to Storage            │
│  5. Generate public URLs                       │
│  6. Create complaint record in DB              │
│  7. Return success response                    │
└────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────────────────┐  ┌──────────────────────┐
│ Supabase Storage  │  │ Supabase PostgreSQL  │
├───────────────────┤  ├──────────────────────┤
│ complaint-        │  │  complaints Table    │
│   evidence/       │  │  ├─ id               │
│   {userId}/       │  │  ├─ user_id          │
│     {orderId}/    │  │  ├─ order_id ◄──────┼─ NEW
│       balance.jpg │  │  ├─ title            │
│       receipt.jpg │  │  ├─ description      │
│                   │  │  ├─ priority         │
│ (Signed URLs)     │  │  ├─ status           │
│                   │  │  ├─ evidence ◄──────┼─ NEW
└───────────────────┘  │  ├─ order_details ◄─┼─ NEW
                       │  ├─ created_at       │
                       │  └─ updated_at       │
                       └──────────────────────┘
```

---

## Customer Complaint Filing Flow

```
START: Customer in Dashboard
  │
  ├─ Navigate to "My Orders"
  │  └─ See table of all purchases
  │
  ├─ Find order to complain about
  │  └─ Display: Network, Package, Phone, Amount, Date, Status
  │
  ├─ Click "Complain" button (MessageSquare icon)
  │  │
  │  ├─ Modal opens
  │  ├─ Order summary populated:
  │  │  ├─ Network: MTN
  │  │  ├─ Package: 5GB
  │  │  ├─ Phone: 0501234567
  │  │  ├─ Amount: GHS 10.50
  │  │  └─ Date: 2024-01-15
  │  │
  │  └─ Form fields ready:
  │     ├─ Description (textarea, min 10 chars)
  │     ├─ Priority (dropdown: Low/Medium/High)
  │     ├─ Balance Evidence (file upload)
  │     └─ Receipt Evidence (file upload)
  │
  ├─ Customer fills Description
  │  └─ "Purchased 2GB but received only 1GB"
  │
  ├─ Customer selects Priority
  │  └─ "High - Serious issue, cannot use data"
  │
  ├─ Customer uploads Data Balance screenshot
  │  ├─ Click upload area
  │  ├─ Select JPG/PNG/WebP file (max 5MB)
  │  ├─ Preview displayed ✓
  │  └─ Validation: Type & Size OK
  │
  ├─ Customer uploads MoMo Receipt screenshot
  │  ├─ Click upload area
  │  ├─ Select JPG/PNG/WebP file (max 5MB)
  │  ├─ Preview displayed ✓
  │  └─ Validation: Type & Size OK
  │
  ├─ Customer clicks "Submit"
  │  │
  │  ├─ Frontend Validation
  │  │  ├─ Description length ≥ 10? ✓
  │  │  ├─ Balance image present? ✓
  │  │  ├─ Receipt image present? ✓
  │  │  └─ User authenticated? ✓
  │  │
  │  ├─ FormData created:
  │  │  ├─ orderId: "550e8400-e29b-41d4-a716-446655440000"
  │  │  ├─ userId: "7c8f5e3a-1b2d-4c6e-9f0a-8b3c5d7e9f1a"
  │  │  ├─ description: "Purchased 2GB but received only 1GB"
  │  │  ├─ priority: "high"
  │  │  ├─ orderDetails: JSON string
  │  │  ├─ balanceImage: File (2.3MB)
  │  │  └─ momoReceiptImage: File (1.8MB)
  │  │
  │  ├─ POST to /api/complaints/create
  │  │  │
  │  │  ├─ Request received on server
  │  │  ├─ All fields validated again
  │  │  │
  │  │  ├─ Upload balance image:
  │  │  │  ├─ Path: "7c8f5e3a.../550e8400.../balance-1705754400000.jpg"
  │  │  │  └─ URL: https://storage.supabase.co/...
  │  │  │
  │  │  ├─ Upload receipt image:
  │  │  │  ├─ Path: "7c8f5e3a.../550e8400.../receipt-1705754400123.jpg"
  │  │  │  └─ URL: https://storage.supabase.co/...
  │  │  │
  │  │  ├─ Create complaint record:
  │  │  │  ├─ INSERT into complaints table
  │  │  │  ├─ order_id: "550e8400-e29b-41d4-a716-446655440000"
  │  │  │  ├─ user_id: "7c8f5e3a-1b2d-4c6e-9f0a-8b3c5d7e9f1a"
  │  │  │  ├─ evidence: {
  │  │  │  │   balance_image_url: "https://...",
  │  │  │  │   momo_receipt_url: "https://..."
  │  │  │  │ }
  │  │  │  ├─ status: "pending"
  │  │  │  └─ created_at: NOW()
  │  │  │
  │  │  └─ Return success response
  │  │
  │  ├─ Success toast displayed:
  │  │  └─ "Complaint submitted successfully!"
  │  │
  │  └─ Modal closes
  │
  └─ Form reset (description, images, priority cleared)
     │
     └─ Complaint now visible to admins
        └─ Admins see images and details
           └─ Can take action/resolve
```

---

## Admin Complaint Resolution Flow

```
START: Admin in Dashboard
  │
  ├─ Navigate to "Admin" → "Complaints"
  │  └─ See all complaints from all customers
  │
  ├─ View Complaint Summary:
  │  ├─ Pending: 5 complaints
  │  ├─ In Progress: 2 complaints
  │  ├─ Resolved: 18 complaints
  │  └─ Total: 25 complaints
  │
  ├─ Filter/Search complaints
  │  ├─ By status: Pending/In-Progress/Resolved
  │  ├─ By priority: Low/Medium/High
  │  ├─ By date range
  │  └─ By keyword search
  │
  ├─ Click on complaint "Purchased 2GB but received only 1GB"
  │  │
  │  ├─ Complaint Details Modal Opens
  │  │  │
  │  │  ├─ Complaint Info:
  │  │  │  ├─ Customer: John Doe
  │  │  │  ├─ Order: MTN 5GB (GHS 10.50)
  │  │  │  ├─ Date: 2024-01-15 10:30 AM
  │  │  │  ├─ Priority: High
  │  │  │  ├─ Status: Pending
  │  │  │  └─ Description: "Purchased 2GB but received only 1GB"
  │  │  │
  │  │  ├─ Evidence Section:
  │  │  │  ├─ Data Balance Screenshot
  │  │  │  │  ├─ Image displayed
  │  │  │  │  ├─ Shows 0GB remaining (problem confirmed)
  │  │  │  │  ├─ Timestamp: 2024-01-20 14:22 UTC
  │  │  │  │  └─ Preview/Download available
  │  │  │  │
  │  │  │  └─ MoMo Receipt Screenshot
  │  │  │     ├─ Image displayed
  │  │  │     ├─ Shows payment of GHS 10.50
  │  │  │     ├─ Timestamp: 2024-01-20 14:21 UTC
  │  │  │     └─ Preview/Download available
  │  │  │
  │  │  ├─ Resolution Section:
  │  │  │  ├─ Status dropdown: [Pending ▼]
  │  │  │  │  ├─ Options:
  │  │  │  │  │  ├─ Pending (current)
  │  │  │  │  │  ├─ In-Progress
  │  │  │  │  │  ├─ Resolved
  │  │  │  │  │  └─ Rejected
  │  │  │  │  │
  │  │  │  │  └─ Select "Resolved"
  │  │  │  │
  │  │  │  └─ Resolution Notes:
  │  │  │     ├─ Textarea
  │  │  │     ├─ Type: "Credited GHS 1GB to customer account"
  │  │  │     └─ Save button
  │  │  │
  │  │  └─ Save/Update Button
  │  │     ├─ Click to save resolution
  │  │     ├─ Status updated: Pending → Resolved
  │  │     ├─ Notes saved
  │  │     ├─ Updated timestamp set
  │  │     └─ Complaint removed from "Pending" list
  │  │
  │  ├─ Success notification
  │  └─ Modal closes
  │
  └─ Customer sees resolved status
     ├─ Next time they view their complaints
     └─ Resolution notes may be visible
```

---

## Database Record Example

```json
{
  "id": "a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c",
  "user_id": "7c8f5e3a-1b2d-4c6e-9f0a-8b3c5d7e9f1a",
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Data Issue - MTN 5GB",
  "description": "Purchased 2GB but received only 1GB",
  "priority": "high",
  "status": "resolved",
  "resolution_notes": "Credited GHS 1GB to customer account",
  "evidence": {
    "balance_image_url": "https://storage.supabase.co/complaint-evidence/7c8f5e3a.../550e8400.../balance-1705754400000.jpg?token=...",
    "momo_receipt_url": "https://storage.supabase.co/complaint-evidence/7c8f5e3a.../550e8400.../receipt-1705754400123.jpg?token=...",
    "balance_image_path": "7c8f5e3a-1b2d-4c6e-9f0a-8b3c5d7e9f1a/550e8400-e29b-41d4-a716-446655440000/balance-1705754400000.jpg",
    "momo_receipt_path": "7c8f5e3a-1b2d-4c6e-9f0a-8b3c5d7e9f1a/550e8400-e29b-41d4-a716-446655440000/receipt-1705754400123.jpg"
  },
  "order_details": {
    "network": "MTN",
    "package": "5GB",
    "phone": "0501234567",
    "amount": 10.50,
    "date": "2024-01-15T10:30:00Z"
  },
  "created_at": "2024-01-20T14:22:00Z",
  "updated_at": "2024-01-20T15:45:30Z"
}
```

---

## Component Hierarchy

```
App
├── Providers
│   └── ThemeProvider
│       └── DashboardLayout
│           ├── Header
│           ├── Sidebar
│           └── Main Content
│               └── MyOrdersPage
│                   ├── OrdersTable
│                   │   ├── Order Row
│                   │   │   ├─ Order Details (network, package, etc)
│                   │   │   └─ Actions Column
│                   │   │      ├─ View Button
│                   │   │      └─ Complain Button ◄── Triggers Modal
│                   │   └── ...
│                   │
│                   └── ComplaintModal (Conditional Render)
│                       ├── DialogHeader
│                       ├── Order Summary Card
│                       ├── Priority Selector
│                       ├── Description Textarea
│                       ├── Balance Image Upload
│                       │   ├─ File Input
│                       │   ├─ Image Preview
│                       │   └─ Change Button
│                       ├── Receipt Image Upload
│                       │   ├─ File Input
│                       │   ├─ Image Preview
│                       │   └─ Change Button
│                       ├── Submit Button
│                       └── Cancel Button
│
└── AdminLayout
    ├── Header
    ├── Sidebar
    └── Main Content
        └── ComplaintsPage
            ├── Stats Cards
            │   ├─ Pending Count
            │   ├─ In Progress Count
            │   └─ Resolved Count
            ├── Filters
            ├── Complaints List
            │   └── Complaint Row
            │       ├─ Customer Info
            │       ├─ Order Info
            │       ├─ Status Badge
            │       ├─ Priority Badge
            │       └─ View Detail Button
            │
            └── Complaint Details Modal
                ├── Complaint Info
                ├── Order Summary
                ├── Evidence Images
                │   ├─ Balance Image
                │   └─ Receipt Image
                ├── Status Selector
                ├── Resolution Notes
                └── Save Button
```

---

## API Call Sequence

```
1. Customer clicks "Complain" button on order
   │
   ├─ Modal opens
   └─ State updated: complaintModalOpen = true
   
2. Customer fills form and clicks Submit
   │
   ├─ Frontend validation
   ├─ FormData created
   │
   └─ POST /api/complaints/create
      │
      ├─ Content-Type: multipart/form-data
      ├─ Body: FormData with all fields + 2 files
      │
      └─ Request reaches Backend

3. Backend receives request
   │
   ├─ Parse FormData
   ├─ Validate all fields
   ├─ Get user authentication context
   │
   ├─ Upload balance image
   │  ├─ supabase.storage.upload(path, buffer)
   │  ├─ Generate public URL
   │  └─ Store URL in variable
   │
   ├─ Upload receipt image
   │  ├─ supabase.storage.upload(path, buffer)
   │  ├─ Generate public URL
   │  └─ Store URL in variable
   │
   ├─ Create complaint record
   │  ├─ supabase.from('complaints').insert({...})
   │  ├─ With order_id, user_id, evidence, order_details
   │  ├─ Status: 'pending'
   │  └─ Return created complaint
   │
   └─ Send success response (200)

4. Frontend receives response
   │
   ├─ Parse JSON response
   ├─ Show success toast
   ├─ Reset form
   ├─ Close modal
   │
   └─ Complaint now in database + Storage
      ├─ Images accessible via URLs
      ├─ Linked to specific order
      ├─ Ready for admin review
      └─ Customer can view in complaints list
```

---

**System is production-ready and awaiting database/storage setup!**
