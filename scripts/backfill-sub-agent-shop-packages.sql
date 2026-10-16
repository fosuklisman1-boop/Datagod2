-- Backfill: sub-agent data prices saved by the rebuilt Shop Pricing page went to
-- shop_packages, which sub-agent storefronts never read. Copy them into
-- sub_agent_shop_packages, keeping the selling price the sub-agent chose.
--
-- That page priced a sub-agent against the admin catalog, so:
--   chosen selling price = (sub-agent's own dealer_price if dealer/admin, else price) + shop_packages.profit_margin
-- The storefront prices a sub-agent as:
--   parent_price = (parent's dealer_price if parent dealer/admin, else price) + parent's wholesale_margin
--   selling      = parent_price + sub_agent_profit_margin
-- so sub_agent_profit_margin = chosen selling price - parent_price.
--
-- Skipped: packages the parent doesn't offer (no active sub_agent_catalog row),
-- unavailable packages, packages the sub-agent already has in
-- sub_agent_shop_packages, and prices below the parent's price (listed by step 1).
--
-- Run step 1, check it, then run step 2.

-- ── Step 1: preview ──────────────────────────────────────────────────────────
WITH candidates AS (
  SELECT
    s.id  AS shop_id,
    s.shop_name,
    p.id  AS package_id,
    p.network,
    p.size,
    sp.is_available,
    (CASE WHEN su.role IN ('dealer', 'admin') AND p.dealer_price > 0 THEN p.dealer_price ELSE p.price END)
      + sp.profit_margin AS selling_price,
    (CASE WHEN pu.role IN ('dealer', 'admin') AND p.dealer_price > 0 THEN p.dealer_price ELSE p.price END)
      + COALESCE(pc.wholesale_margin, 0) AS parent_price
  FROM user_shops s
  JOIN users su             ON su.id = s.user_id
  JOIN user_shops ps        ON ps.id = s.parent_shop_id
  JOIN users pu             ON pu.id = ps.user_id
  JOIN shop_packages sp     ON sp.shop_id = s.id
  JOIN packages p           ON p.id = sp.package_id AND p.is_available = true
  JOIN sub_agent_catalog pc ON pc.shop_id = ps.id AND pc.package_id = p.id AND pc.is_active = true
  WHERE s.parent_shop_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM sub_agent_shop_packages x
      WHERE x.shop_id = s.id AND x.package_id = p.id
    )
)
SELECT
  shop_name, network, size, parent_price, selling_price,
  ROUND(selling_price - parent_price, 2) AS sub_agent_profit_margin,
  CASE WHEN selling_price < parent_price THEN 'SKIP: below parent price' ELSE 'insert' END AS action
FROM candidates
ORDER BY shop_name, network, size;

-- ── Step 2: insert ───────────────────────────────────────────────────────────
BEGIN;

INSERT INTO sub_agent_shop_packages (shop_id, package_id, parent_price, sub_agent_profit_margin, is_active)
SELECT shop_id, package_id, parent_price, ROUND(selling_price - parent_price, 2), is_available
FROM (
  SELECT
    s.id AS shop_id,
    p.id AS package_id,
    sp.is_available,
    (CASE WHEN su.role IN ('dealer', 'admin') AND p.dealer_price > 0 THEN p.dealer_price ELSE p.price END)
      + sp.profit_margin AS selling_price,
    (CASE WHEN pu.role IN ('dealer', 'admin') AND p.dealer_price > 0 THEN p.dealer_price ELSE p.price END)
      + COALESCE(pc.wholesale_margin, 0) AS parent_price
  FROM user_shops s
  JOIN users su             ON su.id = s.user_id
  JOIN user_shops ps        ON ps.id = s.parent_shop_id
  JOIN users pu             ON pu.id = ps.user_id
  JOIN shop_packages sp     ON sp.shop_id = s.id
  JOIN packages p           ON p.id = sp.package_id AND p.is_available = true
  JOIN sub_agent_catalog pc ON pc.shop_id = ps.id AND pc.package_id = p.id AND pc.is_active = true
  WHERE s.parent_shop_id IS NOT NULL
) c
WHERE selling_price >= parent_price
ON CONFLICT (shop_id, package_id) DO NOTHING;

-- Check the row count printed above, then:
COMMIT;
-- (or ROLLBACK; if it looks wrong)
