# MTN Fulfillment Admin UI - Visual Guide

## Admin Orders Page - Fulfillment Tab

### Tab Navigation
Located at the top of **Admin > Orders** page:

```
┌─────────────────────────────────────────────────────────┐
│  Order Management                                        │
│  Download and manage pending orders                      │
├─────────────────────────────────────────────────────────┤
│  [⏰ Pending (125)]  [✓ Downloaded (3)]  [⚡ Fulfillment] │
└─────────────────────────────────────────────────────────┘
```

Click **⚡ Fulfillment** tab to see:

---

## 1. Auto-Fulfillment Toggle Card

```
┌──────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ✓ Auto-Fulfillment                                   │ │
│  │ Automatically fulfill orders via Code Craft Network API  │ │
│  │                                            Enabled ◉→|   │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Status Information:                                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ℹ Auto-fulfillment is ON:                              │ │
│  │   Telecel, AT-iShare, and AT-BigTime orders are        │ │
│  │   automatically fulfilled via Code Craft API.          │ │
│  │   These orders will NOT appear in the admin queue.     │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Toggle Behavior**:
- 🟢 **Enabled (ON)**: MTN orders auto-process to MTN API
- 🔴 **Disabled (OFF)**: MTN orders queue for manual fulfillment

---

## 2. Fulfillment Dashboard Card

```
┌──────────────────────────────────────────────────────────────┐
│  Code Craft Fulfillment Dashboard                            │
│  Monitor and manage data bundle fulfillment through          │
│  Code Craft Network API                                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                      ⚡                                       │
│                                                              │
│                  Fulfillment Dashboard                       │
│         View real-time fulfillment status for               │
│           auto-fulfilled orders                              │
│                                                              │
│          [⚡ Open Fulfillment Dashboard]  [↻ Sync...]       │
│                                                              │
│     Use "Sync Processing Orders" to check all orders        │
│      stuck at "processing" status with CodeCraft            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. MTN Pending Manual Fulfillment Card

This is the main section for managing queued orders.

### Header with Count
```
┌──────────────────────────────────────────────────────────────┐
│  📱 MTN    Pending Manual Fulfillment           [Pending: 5]  │
│  Orders queued for manual MTN fulfillment                    │
└──────────────────────────────────────────────────────────────┘
```

### Empty State (All Fulfilled)
```
┌──────────────────────────────────────────────────────────────┐
│  📱 MTN    Pending Manual Fulfillment           [Pending: 0]  │
│  Orders queued for manual MTN fulfillment                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ✓ No pending MTN orders. All orders have been fulfilled!   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### With Pending Orders

```
┌──────────────────────────────────────────────────────────────┐
│  📱 MTN    Pending Manual Fulfillment           [Pending: 3]  │
│  Orders queued for manual MTN fulfillment                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  ORD-20241215-001                                       │ │
│  │  +233541234567 • 1GB                                    │ │
│  │  [MTN] Created: 12/15/2024, 2:30 PM                    │ │
│  │                                    ₵ 5.99  [Fulfill]   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  ORD-20241215-002                                       │ │
│  │  +233551234567 • 2GB                                    │ │
│  │  [MTN] Created: 12/15/2024, 3:15 PM    [⏳ Fulfilling...] │
│  │                                            ₵ 9.99       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  ORD-20241215-003                                       │ │
│  │  +233501234567 • 5GB                                    │ │
│  │  [MTN] Created: 12/15/2024, 4:00 PM    [✓ Fulfilled]   │ │
│  │                                            ₵ 19.99      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Order Card Breakdown

### Card States

#### 1. **Pending** (Waiting for Admin Action)
```
┌──────────────────────────────────────────────┐
│ ORD-20241215-001                             │
│ +233541234567 • 1GB                          │
│ [MTN] Created: 12/15/2024, 2:30 PM           │
│                              ₵ 5.99 [Fulfill]│
└──────────────────────────────────────────────┘
```
- Order ID (monospace font)
- Phone number + data size
- Network badge (colored)
- Timestamp
- Price in GHS
- **Fulfill button** (orange, enabled)

#### 2. **Fulfilling** (Processing to MTN)
```
┌──────────────────────────────────────────────┐
│ ORD-20241215-002                             │
│ +233551234567 • 2GB                          │
│ [MTN] Created: 12/15/2024, 3:15 PM           │
│                    ₵ 9.99 [⏳ Fulfilling...]  │
└──────────────────────────────────────────────┘
```
- Same info as pending
- **Fulfill button** shows loading spinner
- **Button disabled** while processing

#### 3. **Fulfilled** (Sent to MTN)
```
┌──────────────────────────────────────────────┐
│ ORD-20241215-003                             │
│ +233501234567 • 5GB                          │
│ [MTN] Created: 12/15/2024, 4:00 PM [✓ Fulfilled]
│                            ₵ 19.99 [✓ Fulfilled]│
└──────────────────────────────────────────────┘
```
- Green "Fulfilled" badge
- **Fulfill button** shows checkmark, disabled
- Order removed on next refresh

#### 4. **Error** (Failed to Fulfill)
```
┌──────────────────────────────────────────────┐
│ ORD-20241215-004                             │
│ +233561234567 • 3GB                          │
│ [MTN] Created: 12/15/2024, 5:00 PM [⚠ Error]│
│                            ₵ 14.99 [Fulfill] │
└──────────────────────────────────────────────┘
```
- Red "Error" badge
- **Fulfill button** enabled again
- Admin can retry

---

## Responsive Design

### Desktop View (Wide Screen)
```
ORDER CARD (Horizontal Layout)
┌─────────────────────────────────────────────────────────┐
│ ORDER INFO (Left)          │  PRICE  │  BUTTON (Right) │
└─────────────────────────────────────────────────────────┘
```

### Mobile View (Narrow Screen)
```
ORDER CARD (Vertical Layout)
┌──────────────────────────────────┐
│ ORDER INFO                       │
│                                  │
│ PRICE          [BUTTON]          │
└──────────────────────────────────┘
```

---

## Color Scheme

### Network Badges
```
MTN          [📱] Orange background (bg-orange-100)
Telecel      [📱] Red background (bg-red-100)
AT - iShare  [📱] Indigo background (bg-indigo-100)
AT - BigTime [📱] Purple background (bg-purple-100)
```

### Status Badges
```
Fulfilled    [✓] Green badge (bg-green-100)
Error        [⚠] Red badge (bg-red-100)
Pending      [No badge]
```

### Buttons
```
Fulfill      Orange: bg-orange-600 → hover: bg-orange-700
Fulfilling   Spinner animation
Fulfilled    Green checkmark, disabled
```

---

## User Interactions

### 1. **Click Fulfill Button**
```
Click on orange [Fulfill] button
    ↓
Button shows loading spinner: [⏳ Fulfilling...]
Button becomes disabled
    ↓
API call to /api/admin/fulfillment/manual-fulfill
    ↓
Success: Green [✓ Fulfilled] badge appears
         Toast: "Order ORD-20241215-001 fulfilled successfully"
         Order removed from list on refresh
    
OR

Failure: Red [⚠ Error] badge appears
         Toast: "Error message explaining what failed"
         Button re-enabled to retry
```

### 2. **Toggle Auto-Fulfillment**
```
Click toggle switch in Auto-Fulfillment card
    ↓
Setting saved to database (app_settings table)
    ↓
New orders follow the new rule immediately
    ↓
Existing pending orders keep their current status
```

### 3. **Refresh Page**
```
Fulfillment tab loads
    ↓
Spinner shows: [⏳] Loading...
    ↓
API call to GET /api/admin/fulfillment/manual-fulfill
    ↓
List updates with latest pending orders
    ↓
Count badge updates
```

---

## Notifications

### Success Toast
```
✓ Order ORD-20241215-001 fulfilled successfully
[appears at bottom right, auto-dismisses after 3s]
```

### Error Toast
```
✗ Failed to fulfill order
  Network error: Unable to reach MTN API
[appears at bottom right, auto-dismisses after 5s]
```

### Loading States
- Tab loads → Spinner in card center
- Button clicks → Spinner in button
- Refresh button → Spinner next to count badge

---

## Key Features Summary

| Feature | How It Works |
|---------|--------------|
| **Auto-Count Badge** | Shows count: "5" or "K" format (e.g., "15K") |
| **One-Click Fulfill** | Single button press sends to MTN API |
| **Real-Time Status** | Immediately updates UI without page refresh |
| **Error Handling** | Clear error messages + retry option |
| **Responsive Layout** | Adapts to mobile/tablet/desktop screens |
| **Color Coding** | Network badges identify order type at a glance |
| **Loading States** | Clear indication that API call is happening |
| **Empty State** | Friendly message when all orders fulfilled |

---

## Common User Flows

### Flow 1: Fulfill One Order
```
1. Click Fulfillment tab
2. See pending orders list
3. Click [Fulfill] on desired order
4. See loading state
5. See success badge + toast
6. Refresh page (automatic on next tab change)
7. Order disappears from list
```

### Flow 2: Disable Auto-Fulfillment
```
1. Click Fulfillment tab
2. See Auto-Fulfillment toggle: ON
3. Click toggle switch
4. Toggle changes to OFF
5. Setting saved immediately
6. New MTN orders now queue instead of auto-process
7. Orders appear in pending list
8. Admin can fulfill manually as needed
```

### Flow 3: Handle Fulfillment Error
```
1. Click Fulfillment tab
2. See order in list
3. Click [Fulfill]
4. See loading state
5. See error: "MTN API unavailable"
6. See red [⚠ Error] badge
7. [Fulfill] button re-enabled
8. Wait for MTN API to recover
9. Click [Fulfill] again to retry
10. Success!
```

---

## Tips for Admins

✅ **Best Practices**:
- Fulfill orders during MTN API working hours
- Batch fulfill multiple orders together (reduces load)
- Check MTN balance periodically (Balance card in Settings)
- Monitor fulfillment error rate
- Keep auto-fulfillment ON for production (faster processing)

⚠️ **Things to Watch**:
- Don't turn off auto-fulfillment unless testing
- Watch for "MTN API unavailable" errors
- Check fulfillment logs if suspicious
- Monitor SMS delivery (verify customers receive notifications)

🔧 **Troubleshooting**:
- Orders stuck in "Fulfilling"? → Refresh page
- Repeated errors? → Check MTN API status
- No SMS sent? → Check SMS service logs
- Wrong phone number? → Check phone validation

---

## Integration with Existing UI

The Fulfillment tab is part of the existing **Orders** page:

```
Admin Dashboard
    ↓
Orders Management
    ├─ Pending tab (existing)
    ├─ Downloaded tab (existing)
    └─ Fulfillment tab (NEW - Phase 2)
         ├─ Auto-Fulfillment toggle
         ├─ Code Craft dashboard
         └─ MTN pending orders list
```

Navigation via sidebar:
```
Dashboard > Orders > Click "Fulfillment" tab
```

---

**This visual guide helps admins understand exactly what they'll see and how to use the new MTN fulfillment interface.**
