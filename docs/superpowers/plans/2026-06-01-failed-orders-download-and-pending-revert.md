# Failed Orders Download + Provider-Failure Pending Revert — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Download Failed Orders" button to the admin bulk-update panel, and stop MTN provider failures from setting customer-facing orders to "failed" — they should revert to "pending" so the team can re-dispatch.

**Architecture:** Each provider-failure write site (6 total) is patched to split the normalized status into `newStatus` (kept for tracking table) and `orderTableStatus` (maps "failed" → "pending" for order tables). The download API gains a `failureMode:'failed'` branch that queries `mtn_fulfillment_tracking` to find failed orders and returns a read-only XLSX export. The customer failure email from the Sykes webhook is suppressed; admin SMS/push stays.

**Tech Stack:** Next.js 15 App Router API routes, Supabase JS client (service role), XLSX (SheetJS), TypeScript, React 19.

---

## File Map

| File | Change |
|------|--------|
| `lib/mtn-fulfillment.ts` | Split status in `updateMTNOrderFromWebhook` + `updateDataKazinaOrderFromPayload` |
| `app/api/webhooks/mtn/xpress/route.ts` | Split status in order-table writes + already no customer email |
| `app/api/cron/sync-mtn-status/route.ts` | Split status in order-table writes |
| `app/api/cron/sync-mtn-status/datakazina/route.ts` | Split status in order-table writes |
| `app/api/cron/sync-mtn-status/xpress/route.ts` | Split status in order-table writes |
| `app/api/webhooks/mtn/route.ts` | Remove customer failure email from `handleOrderFailed` |
| `app/api/admin/orders/download/route.ts` | Add `failureMode:'failed'` early-return branch |
| `app/admin/order-payment-status/page.tsx` | Add failed-count state + `handleBulkDownloadFailed` + "Download Failed" button |

---

## Task 1: Status split in `lib/mtn-fulfillment.ts` (Sykes + DataKazina)

**Files:**
- Modify: `lib/mtn-fulfillment.ts`

This file contains two webhook/update functions that write both to `mtn_fulfillment_tracking` and to the customer-facing order tables. We split the normalized status so tracking keeps `"failed"` but order tables see `"pending"`.

- [ ] **Step 1: Open `lib/mtn-fulfillment.ts` and locate `updateMTNOrderFromWebhook` (around line 780)**

The function currently computes `newStatus` at lines 786–793 and uses it for both tracking writes and order-table writes.

- [ ] **Step 2: Add the `orderTableStatus` split immediately after the `newStatus` computation**

Find this block (around line 793):
```ts
    const newStatus =
      webhook.order.status === "completed"
        ? "completed"
        : webhook.order.status === "failed"
          ? "failed"
          : webhook.order.status === "processing"
            ? "processing"
            : "pending"

    // Update tracking table
```

Replace with:
```ts
    const newStatus =
      webhook.order.status === "completed"
        ? "completed"
        : webhook.order.status === "failed"
          ? "failed"
          : webhook.order.status === "processing"
            ? "processing"
            : "pending"

    // Tracking keeps "failed" so the dedupe guard in fulfillment-service.ts
    // can verify with the provider before allowing retry.
    // Order tables see "pending" so customers see the order as re-fulfillable.
    const orderTableStatus = newStatus === "failed" ? "pending" : newStatus

    // Update tracking table
```

- [ ] **Step 3: Replace `newStatus` with `orderTableStatus` in the order-table writes inside `updateMTNOrderFromWebhook`**

Locate the three update blocks that write to `orders`, `api_orders`, and `shop_orders` (around lines 823–868). They look like:

```ts
      await supabase
        .from("orders")
        .update({
          status: newStatus,
          ...
        })
```

and

```ts
      await supabase
        .from("api_orders")
        .update({
          status: newStatus,
          ...
        })
```

and

```ts
      await supabase
        .from("shop_orders")
        .update({
          order_status: newStatus,
          ...
        })
```

Change `status: newStatus` / `order_status: newStatus` → `status: orderTableStatus` / `order_status: orderTableStatus` in **all three** of these blocks. The tracking-table write above them (`from("mtn_fulfillment_tracking").update({ status: newStatus, ... })`) must stay as `newStatus`.

- [ ] **Step 4: Locate `updateDataKazinaOrderFromPayload` (around line 895) and add the same split**

The function computes `newStatus` around line 917. Find the comment just above the tracking-table write (around line 950):

```ts
    // Update tracking table
    const { error: trackingError } = await supabase
      .from("mtn_fulfillment_tracking")
      .update({
        status: newStatus,
```

Insert the split immediately before that comment:
```ts
    // Tracking keeps "failed"; order tables see "pending" to allow re-fulfillment
    const orderTableStatus = newStatus === "failed" ? "pending" : newStatus

    // Update tracking table
    const { error: trackingError } = await supabase
      .from("mtn_fulfillment_tracking")
      .update({
        status: newStatus,
```

- [ ] **Step 5: Replace `newStatus` → `orderTableStatus` in `updateDataKazinaOrderFromPayload` order-table writes**

There are five `.update()` calls to order tables in this function (around lines 978–1013): `orders`, `api_orders`, `ussd_orders`, `ussd_shop_orders`, and `shop_orders`. Each looks like `.update({ status: newStatus })` or `.update({ order_status: newStatus })`.

Change every `status: newStatus` / `order_status: newStatus` in these five calls to `status: orderTableStatus` / `order_status: orderTableStatus`. The tracking-table write keeps `newStatus`.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors relating to `updateMTNOrderFromWebhook` or `updateDataKazinaOrderFromPayload`. Fix any type errors before continuing.

- [ ] **Step 7: Commit**

```bash
git add lib/mtn-fulfillment.ts
git commit -m "fix: provider failure maps to pending in order tables, tracking stays failed (Sykes+DataKazina)"
```

---

## Task 2: Status split in Xpress webhook (`app/api/webhooks/mtn/xpress/route.ts`)

**Files:**
- Modify: `app/api/webhooks/mtn/xpress/route.ts`

The Xpress webhook already only notifies admins on failure (no customer email). We only need the `orderTableStatus` split in the order-table writes.

- [ ] **Step 1: Locate the order-table write block (around line 199)**

It looks like:
```ts
        if (tracking.order_type === "bulk" && tracking.order_id) {
            await supabase.from("orders").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
            const apiId = tracking.api_order_id || tracking.order_id
            await supabase.from("api_orders").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", apiId)
        } else if (tracking.order_type === "ussd" && tracking.order_id) {
            await supabase.from("ussd_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
            await supabase.from("ussd_shop_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.shop_order_id) {
            await supabase.from("shop_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.shop_order_id)
        }
```

- [ ] **Step 2: Add the split immediately before that block**

Insert one line before the `if (tracking.order_type === "bulk"` line:
```ts
        // Order tables see "pending" instead of "failed" — customers see re-fulfillable
        const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
```

- [ ] **Step 3: Replace `newStatus` with `orderTableStatus` in all five order-table `.update()` calls in that block**

After the change the block should read:
```ts
        const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
        if (tracking.order_type === "bulk" && tracking.order_id) {
            await supabase.from("orders").update({ status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
            const apiId = tracking.api_order_id || tracking.order_id
            await supabase.from("api_orders").update({ status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", apiId)
        } else if (tracking.order_type === "ussd" && tracking.order_id) {
            await supabase.from("ussd_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
            await supabase.from("ussd_shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.shop_order_id) {
            await supabase.from("shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.shop_order_id)
        }
```

The tracking-table write above (the `supabase.from("mtn_fulfillment_tracking").update({ status: newStatus, ...})` block) must stay as `newStatus`.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/mtn/xpress/route.ts
git commit -m "fix: Xpress provider failure maps to pending in order tables"
```

---

## Task 3: Status split in Sykes cron (`app/api/cron/sync-mtn-status/route.ts`)

**Files:**
- Modify: `app/api/cron/sync-mtn-status/route.ts`

The cron computes `normalizedStatus` and writes it to both the tracking table and order tables. We add the split before the order-table writes.

- [ ] **Step 1: Locate the tracking-table update block (around line 347)**

It looks like:
```ts
          const { error: trackingError } = await supabase
            .from("mtn_fulfillment_tracking")
            .update({
              status: normalizedStatus,
              external_status: providerOrder.status,
              external_message: providerOrder.message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", order.id)
```

Just after the `if (trackingError)` block that follows, there is a comment:
```ts
          // Update corresponding order table and send notification
          let userId: string | null = null
```

- [ ] **Step 2: Insert the split before `// Update corresponding order table`**

```ts
          // Order tables see "pending" instead of "failed" — customers see re-fulfillable.
          // Tracking keeps normalizedStatus so the dedupe guard can verify before retry.
          const orderTableStatus = normalizedStatus === "failed" ? "pending" : normalizedStatus

          // Update corresponding order table and send notification
          let userId: string | null = null
```

- [ ] **Step 3: Replace `normalizedStatus` with `orderTableStatus` in all order-table `.update()` calls in this cron**

There are five update blocks: `orders` (~line 376), `api_orders` (~line 393), `ussd_orders` (~line 410), `ussd_shop_orders` (~line 426), `shop_orders` (~line 442). Each looks like `.update({ status: normalizedStatus, ... })` or `.update({ order_status: normalizedStatus, ... })`.

Change each to use `orderTableStatus` instead. Do NOT change the tracking-table write above — that keeps `normalizedStatus`.

After the change, the `orders` block should look like:
```ts
            const { data: orderData, error: orderError } = await supabase
              .from("orders")
              .update({
                status: orderTableStatus,
                updated_at: new Date().toISOString(),
              })
              .eq("id", order.order_id)
              .select("user_id, network, size, phone_number")
              .single()
```

Apply the same pattern to `api_orders`, `ussd_orders`, `ussd_shop_orders`, and `shop_orders`.

- [ ] **Step 4: Check the in-app notification block (around line 467)**

It reads:
```ts
          if (userId && (normalizedStatus === "completed" || normalizedStatus === "failed")) {
```

This is fine — notifications use `normalizedStatus` (the provider's actual status). We are not changing this line. The notification is an in-app (database) notification to the order owner about the real provider status, which is separate from the customer failure *email*. Leave it as-is.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/sync-mtn-status/route.ts
git commit -m "fix: Sykes cron provider failure maps to pending in order tables"
```

---

## Task 4: Status split in DataKazina cron (`app/api/cron/sync-mtn-status/datakazina/route.ts`)

**Files:**
- Modify: `app/api/cron/sync-mtn-status/datakazina/route.ts`

- [ ] **Step 1: Locate the tracking-table update (around line 109)**

```ts
                        await supabase
                            .from("mtn_fulfillment_tracking")
                            .update({
                                status: newStatus,
                                external_status: result.order?.status || newStatus,
                                external_message: result.message,
                                updated_at: new Date().toISOString()
                            })
                            .eq("id", order.id)

                        // Update original order record
                        if (order.order_type === "bulk" && order.order_id) {
                            await supabase.from("orders").update({ status: newStatus }).eq("id", order.order_id)
                        } else if (order.shop_order_id) {
                            await supabase.from("shop_orders").update({ order_status: newStatus }).eq("id", order.shop_order_id)
                        }
```

- [ ] **Step 2: Insert the split before `// Update original order record`**

```ts
                        // Order tables see "pending" instead of "failed"
                        const orderTableStatus = newStatus === "failed" ? "pending" : newStatus

                        // Update original order record
                        if (order.order_type === "bulk" && order.order_id) {
                            await supabase.from("orders").update({ status: orderTableStatus }).eq("id", order.order_id)
                        } else if (order.shop_order_id) {
                            await supabase.from("shop_orders").update({ order_status: orderTableStatus }).eq("id", order.shop_order_id)
                        }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/sync-mtn-status/datakazina/route.ts
git commit -m "fix: DataKazina cron provider failure maps to pending in order tables"
```

---

## Task 5: Status split in Xpress cron (`app/api/cron/sync-mtn-status/xpress/route.ts`)

**Files:**
- Modify: `app/api/cron/sync-mtn-status/xpress/route.ts`

- [ ] **Step 1: Locate the tracking-table update (around line 86)**

```ts
                    await supabase
                        .from("mtn_fulfillment_tracking")
                        .update({
                            status: newStatus,
                            external_status: result.order?.status || newStatus,
                            external_message: result.message,
                            updated_at: new Date().toISOString(),
                        })
                        .eq("id", order.id)

                    // Mirror status to the originating order table
                    if (order.order_type === "bulk" && order.order_id) {
                        await supabase.from("orders").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                    } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
                        const apiId = order.api_order_id || order.order_id
                        await supabase.from("api_orders").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", apiId)
                    } else if (order.order_type === "ussd" && order.order_id) {
                        await supabase.from("ussd_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                    } else if (order.order_type === "ussd_shop" && order.order_id) {
                        await supabase.from("ussd_shop_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                    } else if (order.shop_order_id) {
                        await supabase.from("shop_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", order.shop_order_id)
                    }
```

- [ ] **Step 2: Insert split before `// Mirror status to the originating order table`**

```ts
                    // Order tables see "pending" instead of "failed"
                    const orderTableStatus = newStatus === "failed" ? "pending" : newStatus

                    // Mirror status to the originating order table
                    if (order.order_type === "bulk" && order.order_id) {
                        await supabase.from("orders").update({ status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                    } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
                        const apiId = order.api_order_id || order.order_id
                        await supabase.from("api_orders").update({ status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", apiId)
                    } else if (order.order_type === "ussd" && order.order_id) {
                        await supabase.from("ussd_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                    } else if (order.order_type === "ussd_shop" && order.order_id) {
                        await supabase.from("ussd_shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                    } else if (order.shop_order_id) {
                        await supabase.from("shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.shop_order_id)
                    }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/sync-mtn-status/xpress/route.ts
git commit -m "fix: Xpress cron provider failure maps to pending in order tables"
```

---

## Task 6: Suppress customer failure email in Sykes webhook (`app/api/webhooks/mtn/route.ts`)

**Files:**
- Modify: `app/api/webhooks/mtn/route.ts`

The `handleOrderFailed` function sends both admin notifications (keep) and a customer failure email (remove).

- [ ] **Step 1: Locate `handleOrderFailed` and find the `sendEmail` block (around line 378)**

It starts after the `notifyAdmins` + push section and looks like:

```ts
    // Send failure Email
    try {
      let emailAddress: string | undefined;
      let customerName: string | undefined;

      if (tracking.shop_order_id) {
        const { data: so } = await supabase.from('shop_orders').select('customer_email, customer_name').eq('id', tracking.shop_order_id).single();
        if (so?.customer_email) { emailAddress = so.customer_email; customerName = so.customer_name; }
      } else if (tracking.order_id) {
        const { data: o } = await supabase.from('orders').select('user_id').eq('id', tracking.order_id).single();
        if (o?.user_id) {
          const { data: u } = await supabase.from('users').select('email, first_name').eq('id', o.user_id).single();
          if (u?.email) { emailAddress = u.email; customerName = u.first_name; }
        }
      }

      if (emailAddress) {
        const { sendEmail, EmailTemplates } = await import("@/lib/email-service");
        const payload = EmailTemplates.orderFailed(
          order.id.toString(),
          order.message || "Order could not be processed"
        );
        await sendEmail({
          to: [{ email: emailAddress, name: customerName }],
          subject: payload.subject,
          htmlContent: (payload as any).htmlContent || payload.html,
          referenceId: order.id.toString(),
          type: 'order_failed'
        });
        log("info", "Webhook", "Sent failure Email", { traceId, email: emailAddress });
      }
    } catch (emailError) {
      log("warn", "Webhook", "Failed to send failure Email", { traceId, error: String(emailError) });
    }
```

- [ ] **Step 2: Delete the entire `// Send failure Email` try/catch block**

Remove those ~25 lines entirely. The `notifyAdmins` block above it and the retry-marking block below it both stay untouched.

After deletion, `handleOrderFailed` should end with the retry-marking block:
```ts
    // Check if eligible for retry
    if (tracking.retry_count < mtnConfig.maxRetries) {
      await supabase
        .from("mtn_fulfillment_tracking")
        .update({
          status: "pending_retry",
          updated_at: new Date().toISOString(),
        })
        .eq("mtn_order_id", order.id)

      log("info", "Webhook", "Order marked for retry", { ... })
    }
  }

  log("warn", "Webhook", "Order failed", { traceId, mtnOrderId: order.id, reason: order.message })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add app/api/webhooks/mtn/route.ts
git commit -m "fix: suppress customer failure email on MTN provider failure; admin notified only"
```

---

## Task 7: Extend download API for failed-orders mode (`app/api/admin/orders/download/route.ts`)

**Files:**
- Modify: `app/api/admin/orders/download/route.ts`

Add an early-return branch for `filters.failureMode === 'failed'` that fetches failed orders via the tracking table, merges with legacy status-failed orders, and returns a read-only XLSX — no status mutations.

- [ ] **Step 1: Locate the request body parsing (around line 41)**

```ts
    const { orderIds: providedIds, orderType, isRedownload, filters } = await request.json()
```

Just below that, `autoFulfillEnabled` is fetched:
```ts
    const autoFulfillEnabled = await isAutoFulfillmentEnabled()
    console.log(`[DOWNLOAD] Auto-fulfillment enabled: ${autoFulfillEnabled}`)
```

- [ ] **Step 2: Insert the failed-mode branch right after the `autoFulfillEnabled` log line**

Paste this entire block after `console.log(\`[DOWNLOAD] Auto-fulfillment enabled: ${autoFulfillEnabled}\`)`:

```ts
    // ── FAILED ORDERS DOWNLOAD MODE ──────────────────────────────────────
    // When failureMode is 'failed', return a read-only export of orders
    // whose most recent MTN tracking attempt is "failed".
    // Does NOT mutate order statuses.
    if (filters?.failureMode === "failed") {
      console.log("[DOWNLOAD] Failed-mode download requested")

      // Step A: get all tracking rows whose status is "failed", most recent first
      const { data: failedTracking } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("shop_order_id, order_id, api_order_id, status, created_at")
        .eq("status", "failed")
        .order("created_at", { ascending: false })

      // Step B: dedupe — first row per logical order ID is the most recent
      // (because we sorted desc). Only include if the LATEST attempt is failed.
      const latestPerOrder = new Map<string, string>()
      for (const t of (failedTracking || [])) {
        const id = (t.shop_order_id || t.order_id || t.api_order_id) as string | null
        if (id && !latestPerOrder.has(id)) latestPerOrder.set(id, t.status)
      }
      const failedTrackedIds = Array.from(latestPerOrder.keys())

      // Helper to apply date/network/time filters to a query
      const applyFilters = (q: ReturnType<typeof supabase.from>) => {
        if (filters.date) {
          const start = filters.startTime
            ? `${filters.date}T${filters.startTime}:00Z`
            : `${filters.date}T00:00:00Z`
          const end = filters.endTime
            ? `${filters.date}T${filters.endTime}:59Z`
            : `${filters.date}T23:59:59Z`
          q = (q as any).gte("created_at", start).lte("created_at", end)
        }
        if (filters.network && filters.network !== "all") {
          q = (q as any).eq("network", filters.network)
        }
        if (autoFulfillEnabled) {
          q = (q as any)
            .neq("network", "AT - iShare")
            .neq("network", "Telecel")
            .neq("network", "AT - BigTime")
        }
        return q as any
      }

      const seen = new Set<string>()
      let failedOrders: any[] = []

      // Step C: query A — orders that have a failed tracking entry
      if (failedTrackedIds.length > 0) {
        const { data: resultA } = await applyFilters(
          supabase.from("combined_orders_view").select("*")
        ).in("id", failedTrackedIds)
        for (const o of (resultA || [])) {
          if (!seen.has(o.id)) { seen.add(o.id); failedOrders.push({ ...o, size: o.volume_gb }) }
        }
      }

      // Step D: query B — legacy orders where status column is still "failed"
      // (written before this PR changed failures to revert to "pending")
      const { data: resultB } = await applyFilters(
        supabase.from("combined_orders_view").select("*")
      ).eq("status", "failed")
      for (const o of (resultB || [])) {
        if (!seen.has(o.id)) { seen.add(o.id); failedOrders.push({ ...o, size: o.volume_gb }) }
      }

      console.log(`[DOWNLOAD] Failed-mode: found ${failedOrders.length} orders`)

      if (failedOrders.length === 0) {
        return NextResponse.json({ error: "No failed orders found" }, { status: 404 })
      }

      // Step E: generate XLSX (same Phone+Size format as regular download)
      const excelData = failedOrders.map((order: any) => {
        const cleanSizeStr = order.size?.toString().replace(/[^0-9.]/g, "")
        const parsedSize = parseFloat(cleanSizeStr)
        return {
          Phone: order.phone_number,
          Size: !isNaN(parsedSize) ? parsedSize : (order.size || ""),
        }
      })
      const worksheet = XLSX.utils.json_to_sheet(excelData)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, "Failed Orders")
      worksheet["!cols"] = [{ wch: 15 }, { wch: 10 }]
      const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" })
      const now = new Date()
      const dateTime = now.toISOString().replace(/[:.]/g, "-").split("Z")[0]
      const fileName = `orders-failed-${filters.network || "all"}-${filters.date || "unknown"}-${dateTime}.xlsx`
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      })
    }
    // ── END FAILED ORDERS DOWNLOAD MODE ──────────────────────────────────
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

If TypeScript complains about `applyFilters`'s return type, cast the initial call: `const q = supabase.from("combined_orders_view").select("*") as any` and work with `any` throughout that helper.

- [ ] **Step 4: Verify the regular download path is untouched**

The existing code after your block starts with:
```ts
    let orders: any[] = []
    let bulkOrderIds: string[] = []
    ...
    let query = supabase.from("combined_orders_view").select("*")
```

None of that is modified.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/orders/download/route.ts
git commit -m "feat: add failed-orders download mode to download API"
```

---

## Task 8: Failed-orders download UI (`app/admin/order-payment-status/page.tsx`)

**Files:**
- Modify: `app/admin/order-payment-status/page.tsx`

Add state, a count-fetch, a download handler, and a button for the failed-orders download.

- [ ] **Step 1: Add one new state variable after the existing `bulkDownloading` state (around line 74)**

```ts
  const [bulkDownloadingFailed, setBulkDownloadingFailed] = useState(false)
```

- [ ] **Step 2: Add the `handleBulkDownloadFailed` handler after `handleBulkDownload` (around line 547)**

```ts
  const handleBulkDownloadFailed = async () => {
    if (!bulkDate) {
      toast.error("Please select a date")
      return
    }

    try {
      setBulkDownloadingFailed(true)

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("You must be logged in to perform this action")
        return
      }

      const payload = {
        orderType: "all",
        isRedownload: true,
        filters: {
          date: bulkDate,
          startTime: bulkStartTime,
          endTime: bulkEndTime,
          network: bulkNetwork,
          failureMode: "failed",
        }
      }

      const response = await fetch("/api/admin/orders/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to download failed orders")
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      a.download = `orders-failed-${bulkNetwork || "all"}-${bulkDate}-${timestamp}.xlsx`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      toast.success("Failed orders download started")
    } catch (error) {
      console.error("[PAYMENT-STATUS] Failed-orders download error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to download failed orders")
    } finally {
      setBulkDownloadingFailed(false)
    }
  }
```

- [ ] **Step 5: Add the "Download Failed" button to the bulk-update button row (around line 732)**

Find the existing button row:
```tsx
                <div className="flex gap-2">
                  <Button
                    onClick={handleBulkStatusUpdate}
                    disabled={bulkUpdating || !bulkDate || !bulkStatus}
                    className="bg-blue-600 hover:bg-blue-700 text-white min-w-[140px]"
                  >
                    ...Update Orders...
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleBulkDownload}
                    disabled={bulkDownloading || !bulkDate}
                    className="border-green-200 hover:bg-green-50 text-green-700 font-semibold"
                  >
                    ...Download Orders...
                  </Button>
                </div>
```

Add a third button inside the `<div className="flex gap-2">`:
```tsx
                  <Button
                    variant="outline"
                    onClick={handleBulkDownloadFailed}
                    disabled={bulkDownloadingFailed || !bulkDate}
                    className="border-red-200 hover:bg-red-50 text-red-700 font-semibold"
                  >
                    {bulkDownloadingFailed ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Preparing...
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4 mr-2" />
                        Download Failed Orders
                      </>
                    )}
                  </Button>
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add app/admin/order-payment-status/page.tsx
git commit -m "feat: add Download Failed Orders button to bulk-update panel"
```

---

## Task 9: Manual smoke tests

No automated test runner is configured. Run these manually in a browser against your local dev server.

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Navigate to `http://localhost:3000/admin/order-payment-status`.

- [ ] **Step 2: Verify the new "Download Failed" button appears**

Expand the Bulk Status Update panel. Enter any date in the date field. Confirm:
- The three buttons are visible: "Update Orders", "Download Orders", "Download Failed (N)".
- The count badge next to "Download Failed" shows a number (or empty if none).
- Clicking "Download Failed" with no date shows a "Please select a date" toast.

- [ ] **Step 3: Test failed-orders download with a real date**

Pick a date when you know there are failed orders in the system (check `mtn_fulfillment_tracking` where `status='failed'` in Supabase Studio).

Click "Download Failed". Confirm:
- An XLSX file downloads with filename `orders-failed-<network>-<date>-<timestamp>.xlsx`.
- The file contains only `Phone` and `Size` columns.
- The rows match orders that have failed tracking entries for that date.
- Checking those order IDs in Supabase: `shop_orders.order_status` or `orders.status` is still `"pending"` (not changed to `"processing"` by the download).

- [ ] **Step 4: Test the existing "Download Orders" button is unchanged**

Click "Download Orders". Confirm it still works: pending orders download, their status flips to `"processing"` in the DB.

- [ ] **Step 5: Simulate a provider failure via curl (Sykes)**

In a terminal, trigger a synthetic Sykes failure webhook. Replace `YOUR_DEV_URL`, `ORDER_ID`, and `SHOP_ORDER_ID` with real values from your DB:

```bash
curl -X POST http://localhost:3000/api/webhooks/mtn \
  -H "Content-Type: application/json" \
  -d '{
    "event": "order.status_changed",
    "timestamp": "2026-06-01T12:00:00Z",
    "order": {
      "id": 99999,
      "status": "failed",
      "message": "Insufficient balance",
      "network": "MTN",
      "size_mb": 1024,
      "recipient_phone": "0241234567"
    }
  }'
```

Then in Supabase Studio, check:
- `mtn_fulfillment_tracking` where `mtn_order_id = 99999`: `status` should be `"failed"`.
- The linked `shop_orders.order_status` or `orders.status`: should be `"pending"` (not `"failed"`).
- No email_logs entry with `type = 'order_failed'` for that order's customer email.

- [ ] **Step 6: Verify the manual-fulfill button appears for the reverted order**

In the admin page, find the order from Step 5. Since its status is now `"pending"` and `payment_status = "completed"`, the "Fulfill" button should appear (matching the visibility check at `order.status === "pending" && order.payment_status === "completed"`).

Click "Fulfill". Confirm the dedupe guard fires (the response should either reconcile the order or proceed with a new fulfillment attempt, depending on what the provider returns for `mtn_order_id=99999`).

- [ ] **Step 7: Final commit / push**

```bash
git push origin feat/moolre-withdrawal-integration
```
