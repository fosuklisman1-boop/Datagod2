-- Find completed ussd_shop_orders where profit_amount is NULL or 0.
-- Handles both direct shops (shop_packages) and sub-agent shops (sub_agent_catalog).

SELECT
  o.id                                                        AS order_id,
  o.created_at,
  u.shop_name,
  o.shop_id,
  CASE WHEN u.parent_shop_id IS NOT NULL THEN 'sub_agent' ELSE 'direct' END AS shop_type,
  u.parent_shop_id,
  o.network,
  o.package_size,
  o.shop_price,
  o.amount,
  o.profit_amount,
  -- For direct shops: current margin from shop_packages
  sp.profit_margin                                            AS direct_profit_margin,
  -- For sub-agent shops: current margins from sub_agent_catalog
  sac.sub_agent_profit_margin                                 AS subagent_profit_margin,
  sac.wholesale_margin                                        AS parent_wholesale_margin
FROM ussd_shop_orders o
JOIN user_shops u ON u.id = o.shop_id
-- Direct shop margin
LEFT JOIN shop_packages sp
  ON sp.shop_id = o.shop_id
  AND sp.package_id = o.package_id
  AND sp.is_available = true
  AND u.parent_shop_id IS NULL
-- Sub-agent catalog margin (keyed on parent_shop_id)
LEFT JOIN sub_agent_catalog sac
  ON sac.shop_id = u.parent_shop_id
  AND sac.package_id = o.package_id
  AND sac.is_active = true
  AND u.parent_shop_id IS NOT NULL
WHERE o.payment_status = 'completed'
  AND (o.profit_amount IS NULL OR o.profit_amount = 0)
ORDER BY u.shop_name, o.created_at;
