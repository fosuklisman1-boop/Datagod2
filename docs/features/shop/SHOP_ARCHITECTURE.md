# Shop Feature - Architecture Diagrams

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        DATAGOD2 - SHOP SYSTEM                   │
└─────────────────────────────────────────────────────────────────┘

┌────────────────────────────────┐      ┌────────────────────────────────┐
│      SHOP OWNER PORTAL         │      │      PUBLIC STOREFRONT         │
│    (Authenticated)             │      │    (Anyone Can Access)         │
├────────────────────────────────┤      ├────────────────────────────────┤
│                                │      │                                │
│  /dashboard/my-shop            │      │  /shop/[slug]                  │
│  ├─ Edit Shop Info             │      │  ├─ Browse Packages            │
│  ├─ Add Products               │      │  ├─ View Pricing               │
│  ├─ Manage Inventory           │      │  ├─ Checkout Form              │
│  └─ View Shop URL              │      │  └─ Responsive Design          │
│                                │      │                                │
│  /dashboard/shop-dashboard     │      │  /shop/[slug]/order-confirmation
│  ├─ View Balance               │      │  └─ Order Details              │
│  ├─ Track Orders               │      │                                │
│  ├─ Request Withdrawal         │      │                                │
│  └─ View Profit History        │      │                                │
│                                │      │                                │
└────────────────────────────────┘      └────────────────────────────────┘
         │                                        │
         │                                        │
         └────────────────┬─────────────────────┘
                          │
                          ▼
         ┌────────────────────────────────┐
         │    Supabase PostgreSQL DB      │
         ├────────────────────────────────┤
         │  ┌──────────────────────────┐  │
         │  │   Authentication         │  │
         │  │   (auth.users table)     │  │
         │  └──────────────────────────┘  │
         │                                │
         │  ┌──────────────────────────┐  │
         │  │   Original Packages      │  │
         │  │   (packages table)       │  │
         │  └──────────────────────────┘  │
         │                                │
         │  ┌──────────────────────────┐  │
         │  │   SHOP TABLES (NEW)      │  │
         │  ├──────────────────────────┤  │
         │  │  • user_shops            │  │
         │  │  • shop_packages         │  │
         │  │  • shop_orders           │  │
         │  │  • shop_profits          │  │
         │  │  • withdrawal_requests   │  │
         │  │  • shop_settings         │  │
         │  └──────────────────────────┘  │
         │                                │
         └────────────────────────────────┘
```

---

## 2. Database Relationship Diagram

```
                    ┌─────────────────┐
                    │   auth.users    │
                    └────────┬────────┘
                             │
                             │ 1
                             │
                    ┌────────▼────────┐
                    │  user_shops     │ (One per user)
                    │  - id (PK)      │
                    │  - user_id (FK) │ UNIQUE
                    │  - shop_name    │
                    │  - shop_slug    │ UNIQUE
                    │  - description  │
                    └────────┬────────┘
                             │
                 ┌───────────┼───────────┐
                 │           │           │
                 │ 1         │ 1         │ 1
                 │           │           │
    ┌────────────▼──┐  ┌─────▼─────────────┐  ┌──────────────┐
    │ shop_packages │  │  shop_orders      │  │shop_settings │
    │ - id (PK)     │  │  - id (PK)        │  │ - id (PK)    │
    │ - shop_id(FK) │  │  - shop_id (FK)   │  │ - shop_id(FK)│
    │ - package_id  │  │  - customer_name  │  │ - commission │
    │ - profit_      │  │  - customer_email │  │ - notification
    │   margin      │  │  - customer_phone │  └──────────────┘
    │ - is_available│  │  - shop_package_id│
    └───────┬───────┘  │  - volume_gb      │
            │          │  - base_price     │
            │ n        │  - profit_amount  │
            │          │  - total_price    │
            │          │  - order_status   │
            │          │  - payment_status │
            │          │  - reference_code │
            │          └────────┬──────────┘
            │                   │
            │                   │ n
            │              ┌────▼───────────┐
            │              │ shop_profits   │
            │              │ - id (PK)      │
            │              │ - shop_id (FK) │
            │              │ - shop_order_id│
            │              │ - profit_amount│
            │              │ - status       │
            │              │ - credited_at  │
            │              └────────┬───────┘
            │                       │
            │                       │ uses
            │                  ┌────▼─────────────────┐
            │                  │withdrawal_requests   │
            │                  │ - id (PK)            │
            │                  │ - shop_id (FK)       │
            │                  │ - user_id (FK)       │
            │                  │ - amount             │
            │                  │ - withdrawal_method  │
            │                  │ - account_details    │
            │                  │ - status             │
            │                  │ - reference_code     │
            │                  └──────────────────────┘
            │
            ▼ n (References back to packages table)
    ┌──────────────────────┐
    │   packages (existing)│
    │ - id (PK)           │
    │ - network           │
    │ - size              │
    │ - base_price        │
    │ - description       │
    └──────────────────────┘
```

---

## 3. Data Flow Diagram

```
CUSTOMER JOURNEY:
═════════════════════════════════════════════════════════════════

1. BROWSE
   Customer
     │
     └──→ Visit: /shop/shop-abc123
            │
            ├─→ Load shop_packages + packages data
            │
            └─→ Display products with:
                 • Network, Size
                 • Base Price
                 • Profit Margin
                 • Total Price

2. SELECT & CHECKOUT
            │
            └──→ Click "Buy Now"
                 │
                 ├─→ Open Checkout Modal
                 │
                 └─→ Customer enters:
                      • Name
                      • Email
                      • Phone (validated)

3. VALIDATE
                 │
                 └─→ Validation checks:
                      ✓ Name not empty
                      ✓ Email format
                      ✓ Phone format (02/05)
                      ✓ Phone length (10 digits)

4. CREATE ORDER
                 │
                 └─→ Submit Order
                      │
                      ├─→ Create shop_orders record
                      │   ├─ customer details
                      │   ├─ package details
                      │   ├─ base_price
                      │   ├─ profit_amount
                      │   └─ total_price
                      │
                      └─→ Create shop_profits record
                          ├─ profit_amount
                          ├─ status: 'pending'
                          └─ link to shop_orders

5. CONFIRMATION
                 │
                 └─→ Show Confirmation Page
                      • Order Number
                      • Reference Code
                      • Pricing Details
                      • Payment Instructions


SHOP OWNER JOURNEY:
═════════════════════════════════════════════════════════════════

1. SETUP
   Shop Owner
     │
     └──→ Go to: /dashboard/my-shop
            │
            └─→ Create/Edit Shop (user_shops)
                 └─→ Get unique slug: /shop/shop-abc123

2. ADD PRODUCTS
            │
            └──→ Click "Add Product"
                 │
                 ├─→ Select package (from packages)
                 │
                 ├─→ Enter profit margin (e.g., 2.50)
                 │
                 └─→ Create shop_packages record
                      ├─ shop_id
                      ├─ package_id
                      ├─ profit_margin
                      └─ is_available: true

3. SHARE STORE
            │
            └──→ Copy shop URL
                 │
                 └─→ Share: /shop/shop-abc123
                      └─→ Customers visit & buy

4. RECEIVE ORDERS
            │
            └──→ Customer purchases
                 │
                 ├─→ shop_orders created
                 │
                 ├─→ shop_profits created (pending)
                 │
                 └─→ Shop owner can see:
                      • Recent Orders
                      • Available Balance

5. TRACK PROFITS
            │
            └──→ Go to: /dashboard/shop-dashboard
                 │
                 ├─→ View Stats:
                 │   ├─ Available Balance (sum of pending profits)
                 │   ├─ Total Profit (pending + credited)
                 │   ├─ Total Orders
                 │   └─ Pending Withdrawals
                 │
                 ├─→ View Order Details
                 │   ├─ Customer name
                 │   ├─ Package details
                 │   ├─ Your profit
                 │   └─ Order status
                 │
                 └─→ View Profit History
                      ├─ Per-order profits
                      ├─ Status tracking
                      └─ Timeline

6. REQUEST WITHDRAWAL
            │
            └──→ Click "Request Withdrawal"
                 │
                 ├─→ Enter amount (≤ available balance)
                 │
                 ├─→ Select method:
                 │   ├─ Mobile Money → Enter phone
                 │   └─ Bank Transfer → Enter details
                 │
                 └─→ Create withdrawal_requests record
                      ├─ amount
                      ├─ withdrawal_method
                      ├─ account_details (JSONB)
                      ├─ status: 'pending'
                      └─ reference_code

7. WAIT FOR APPROVAL
            │
            └─→ Status updates (by admin):
                 pending → approved → processing → completed
                 │                                     │
                 └─────── Shop owner gets paid ────────┘
```

---

## 4. Profit Distribution Flow

```
TRANSACTION: Customer buys MTN 5GB for GHS 22.00
═════════════════════════════════════════════════════════════════

BEFORE:
┌─────────────────────────────────────────┐
│ Shop Owner Account: GHS 0.00            │
│ Platform Account: GHS 0.00              │
└─────────────────────────────────────────┘

CUSTOMER PAYS: GHS 22.00
      │
      ├─→ GHS 19.50 (Base Package Price)
      │        │
      │        └─→ Platform Revenue
      │            └─→ Stored in platform wallet
      │
      └─→ GHS 2.50 (Profit Margin)
               │
               └─→ Shop Owner Profit
                   └─→ Created in shop_profits table
                       └─→ Status: 'pending'
                           └─→ Available in Balance

AFTER:
┌─────────────────────────────────────────┐
│ Shop Owner:                             │
│   Available Balance: GHS 2.50 (pending) │
│   Can request withdrawal                │
│                                         │
│ Platform:                               │
│   Received: GHS 19.50                   │
│   (stored for operations)               │
└─────────────────────────────────────────┘

WITHDRAWAL FLOW:
GHS 2.50 (Available Balance)
   │
   ├─→ Shop owner requests withdrawal
   │
   ├─→ Status: pending → approved
   │
   ├─→ Status: approved → processing
   │
   └─→ Status: processing → completed
        │
        └─→ Money transferred to shop owner
            └─→ shop_profits.status = 'credited'
```

---

## 5. State Machines

### Order Status Machine
```
Order States:
                                  ┌─────────────┐
                                  │   pending   │ (Initial)
                                  └──────┬──────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │ processing  │ (Being fulfilled)
                                  └──────┬──────┘
                                         │
                          ┌──────────────┴──────────────┐
                          │                             │
                          ▼                             ▼
                    ┌─────────────┐           ┌─────────────┐
                    │ completed   │           │   failed    │
                    └─────────────┘           └──────┬──────┘
                                                     │
                                                     ▼
                                             ┌─────────────┐
                                             │  refunded   │
                                             └─────────────┘

Payment Status Machine:
                    ┌──────────────┐
                    │   pending    │ (Initial)
                    └──────┬───────┘
                           │
                ┌──────────┴──────────┐
                │                     │
                ▼                     ▼
          ┌──────────┐          ┌──────────┐
          │completed │          │  failed  │
          └──────────┘          └──────────┘

When order_status = 'completed':
   → Creates entry in shop_profits with status='pending'
   → profit_amount becomes part of Available Balance
```

### Withdrawal Status Machine
```
Withdrawal States:
                    ┌──────────────┐
                    │   pending    │ (Initial - awaiting admin)
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  approved    │ (Admin approved)
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  processing  │ (Being transferred)
                    └──────┬───────┘
                           │
                ┌──────────┴──────────┐
                │                     │
                ▼                     ▼
          ┌──────────┐          ┌──────────┐
          │completed │          │ rejected │
          └──────────┘          └──────────┘
              │
              └─→ Money received by shop owner
                  └─→ shop_profits marked 'credited'
```

---

## 6. URL Structure

```
PUBLIC STOREFRONTS:
├─ /shop/[slug]
│  └─ Example: /shop/shop-abc123
│     └─ Shows all products for that shop
│
└─ /shop/[slug]/order-confirmation/[orderId]
   └─ Example: /shop/shop-abc123/order-confirmation/ord-12345
      └─ Shows order confirmation details

ADMIN/OWNER PAGES:
├─ /dashboard/my-shop
│  └─ Manage shop and products
│
└─ /dashboard/shop-dashboard
   └─ Track profits and withdrawals

DATABASE SLUGS:
├─ shop_slug (unique)
│  └─ Generated as: "shop-" + first 8 chars of UUID
│
└─ reference_code (for orders & withdrawals)
   └─ Generated as: "ORD-" or "WD-" + timestamp + random
```

---

## 7. Mobile Responsive Design

```
DESKTOP (1024px+):
┌───────────────────────────────────────────┐
│ SHOP NAME        [LOGO]                   │
├───────────────────────────────────────────┤
│ PRODUCT 1    PRODUCT 2    PRODUCT 3       │
│ [Card]       [Card]       [Card]          │
└───────────────────────────────────────────┘

TABLET (768px):
┌──────────────────────────┐
│ SHOP NAME   [LOGO]       │
├──────────────────────────┤
│ PRODUCT 1    PRODUCT 2   │
│ [Card]       [Card]      │
├──────────────────────────┤
│ PRODUCT 3                │
│ [Card]                   │
└──────────────────────────┘

MOBILE (320px):
┌────────────────┐
│ SHOP NAME      │
│ [LOGO]         │
├────────────────┤
│ PRODUCT 1      │
│ [Card]         │
├────────────────┤
│ PRODUCT 2      │
│ [Card]         │
├────────────────┤
│ PRODUCT 3      │
│ [Card]         │
└────────────────┘
```

---

## 8. Feature Matrix

```
FEATURE                 │ OWNER │ CUSTOMER │ PUBLIC │ ADMIN
────────────────────────┼───────┼──────────┼────────┼──────
Browse Packages         │   ✓   │    ✓     │   ✓    │   ✓
View Pricing            │   ✓   │    ✓     │   ✓    │   ✓
Place Order             │   ✓   │    ✓     │   ✓    │   ✓
Manage Shop             │   ✓   │    ✗     │   ✗    │   ✓
Add Products            │   ✓   │    ✗     │   ✗    │   ✓
View Profits            │   ✓   │    ✗     │   ✗    │   ✓
Request Withdrawal      │   ✓   │    ✗     │   ✗    │   ✓
Approve Withdrawal      │   ✗   │    ✗     │   ✗    │   ✓
Process Payment         │   ✗   │    ✓     │   ✓    │   ✓
View Analytics          │   ✓   │    ✗     │   ✗    │   ✓
```

---

## 9. Security & Authorization Matrix

```
RESOURCE            │ OWNER │ CUSTOMER │ PUBLIC │ ADMIN │ UNAUTHENTICATED
────────────────────┼───────┼──────────┼────────┼───────┼──────────────
Own Shop            │ CRUD  │    ✗     │   R    │ CRUD  │      ✗
Own Packages        │ CRUD  │    ✗     │   R    │ CRUD  │      ✗
Own Orders          │  R    │    ✗     │   ✗    │ CRUD  │      ✗
Own Profits         │  R    │    ✗     │   ✗    │ CRUD  │      ✗
Withdrawals         │ CRU   │    ✗     │   ✗    │ CRUD  │      ✗
Create Order        │ C     │    C     │   C    │   C   │      C
View Shop           │  R    │    R     │   R    │   R   │      R
View Storefront     │  R    │    R     │   R    │   R   │      R

C = Create, R = Read, U = Update, D = Delete
```

---

## 10. Integration Points

```
DATAGOD2 SYSTEM:
┌──────────────────────────────────────────────────────────┐
│                   EXISTING FEATURES                      │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  • Authentication (Supabase Auth)                       │
│  • User Management                                      │
│  • Original Packages Table                              │
│  • Wallet/Balance System                                │
│  • Transaction Tracking                                 │
│  • Dashboard Layout                                     │
│  • UI Components (shadcn/ui)                            │
│                                                          │
└──────────────────────────────────────────────────────────┘
                          │
                          │ INTEGRATES WITH
                          ▼
┌──────────────────────────────────────────────────────────┐
│                  SHOP FEATURE (NEW)                      │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  • Shop Management & Storefronts                         │
│  • Profit Tracking                                      │
│  • Withdrawal System                                    │
│  • Order Management                                     │
│  • Customer Checkout                                    │
│  • Analytics Dashboard                                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

**Visual Architecture Guide - Shop Feature v1.0**
**All diagrams ASCII-based for markdown compatibility**
