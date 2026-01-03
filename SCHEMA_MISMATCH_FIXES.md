# Schema Mismatch Fixes - January 3, 2026

## Issues Found and Fixed

### 1. **Shop Settings API - Column Mismatch** ✅ FIXED
**File**: `app/api/shop/settings/[shopId]/route.ts`
**Issue**: The API was trying to SELECT non-existent columns from `shop_settings` table
```sql
-- WRONG (non-existent columns):
SELECT id, shop_name, description, is_active, user_id, created_at 
FROM shop_settings WHERE shop_id = ?

-- CORRECT (actual columns that exist):
SELECT id, shop_id, whatsapp_link, created_at, updated_at 
FROM shop_settings WHERE shop_id = ?
```
**Actual `shop_settings` table columns**:
- id (UUID)
- shop_id (UUID)
- whatsapp_link (VARCHAR)
- created_at (TIMESTAMP)
- updated_at (TIMESTAMP)

**Commit**: `4c223f0`

---

### 2. **Sub-Agent Catalog GET - Column Selection Mismatch** ✅ FIXED
**File**: `app/api/shop/sub-agent-catalog/route.ts` (GET endpoint)
**Issue**: API was selecting ALL columns from both tables, but they have different schemas

#### Table: `sub_agent_shop_packages` (for sub-agents' own inventory)
**Columns that EXIST**:
- id, shop_id, package_id, parent_price, sub_agent_profit_margin, is_active, created_at, updated_at

**Columns that DON'T EXIST**:
- ❌ wholesale_margin (this is in sub_agent_catalog, not here)

#### Table: `sub_agent_catalog` (for parent's offerings to sub-agents)
**Columns that EXIST**:
- id, shop_id, package_id, wholesale_margin, is_active, created_at, updated_at

**Columns that DON'T EXIST**:
- ❌ parent_price (this is in sub_agent_shop_packages, not here)
- ❌ sub_agent_profit_margin (this is in sub_agent_shop_packages, not here)

**Fix Applied**:
```typescript
// Now selects correct columns based on which table is queried
const selectFields = tableName === "sub_agent_shop_packages"
  ? `id, package_id, parent_price, sub_agent_profit_margin, is_active, created_at, package:packages (...)`
  : `id, package_id, wholesale_margin, is_active, created_at, package:packages (...)`
```

**Commit**: `a4276ee`

---

### 3. **Sub-Agent Catalog Fallback Query - Column Mismatch** ✅ FIXED
**File**: `app/api/shop/sub-agent-catalog/route.ts` (GET fallback logic)
**Issue**: When querying fallback table (`sub_agent_catalog`), the API was still requesting `parent_price` and `sub_agent_profit_margin` columns which don't exist there

**Fix**: Changed fallback query to select ONLY columns that exist in `sub_agent_catalog`:
```typescript
.select(`id, package_id, wholesale_margin, is_active, created_at, package:packages (...)`)
```

**Commit**: `a4276ee`

---

### 4. **Sub-Agent Catalog PUT - Table Selection Mismatch** ✅ FIXED
**File**: `app/api/shop/sub-agent-catalog/route.ts` (PUT endpoint)
**Issue**: PUT endpoint was ALWAYS updating `sub_agent_catalog`, even for sub-agents whose data is in `sub_agent_shop_packages`

**Fix**: 
```typescript
const tableName = shop.parent_shop_id ? "sub_agent_shop_packages" : "sub_agent_catalog"

// Then dynamically set fields based on table:
if (tableName === "sub_agent_shop_packages") {
  if (sub_agent_profit_margin !== undefined) updateData.sub_agent_profit_margin = ...
  if (parent_price !== undefined) updateData.parent_price = ...
} else {
  if (wholesale_margin !== undefined) updateData.wholesale_margin = ...
}
```

**Commit**: `a4276ee`

---

### 5. **Sub-Agent Catalog DELETE - Table Selection Mismatch** ✅ FIXED
**File**: `app/api/shop/sub-agent-catalog/route.ts` (DELETE endpoint)
**Issue**: DELETE endpoint was ALWAYS deleting from `sub_agent_catalog`, even for sub-agents whose data is in `sub_agent_shop_packages`

**Fix**: Applied same table selection logic as PUT:
```typescript
const tableName = shop.parent_shop_id ? "sub_agent_shop_packages" : "sub_agent_catalog"
// Then use that tableName for all delete operations
```

**Commit**: `a4276ee`

---

## Summary

| Component | Issue Type | Status | Commit |
|-----------|-----------|--------|--------|
| shop_settings API | Column mismatch | ✅ FIXED | 4c223f0 |
| sub-agent-catalog GET | Column selection | ✅ FIXED | a4276ee |
| sub-agent-catalog GET fallback | Column selection | ✅ FIXED | a4276ee |
| sub-agent-catalog PUT | Table selection | ✅ FIXED | a4276ee |
| sub-agent-catalog DELETE | Table selection | ✅ FIXED | a4276ee |

## Why These Caused Products Not to Display

1. **Settings API 400 error** → prevented my-shop page from loading properly
2. **Column selection errors** → Supabase returned errors trying to select non-existent columns
3. **Fallback queries** → When primary table failed, fallback also failed due to wrong columns
4. **PUT/DELETE on wrong table** → Any updates a sub-agent tried to make would fail silently

All these issues have now been resolved. Products should now display correctly!
