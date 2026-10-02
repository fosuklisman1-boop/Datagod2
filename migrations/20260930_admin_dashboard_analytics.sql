-- All-time breakdown panels for the Admin Dashboard hub (Revenue by Network,
-- Growth & Roles, By Product, By Source, Top Packages, Top Agents).
-- Unlike get_admin_dashboard_hub_stats (range-scoped), this is deliberately
-- all-time: these are lifetime composition panels, not a live-performance view.
CREATE OR REPLACE FUNCTION get_admin_dashboard_analytics()
RETURNS JSON AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_by_network JSON;
    v_by_product JSON;
    v_by_source JSON;
    v_top_packages JSON;
    v_top_agents JSON;
    v_role_mix JSON;
    v_new_7d BIGINT := 0;
    v_new_30d BIGINT := 0;
    v_expiring BIGINT := 0;
    v_result JSON;
BEGIN
    -- Revenue by network (Data orders only, across all 5 source tables)
    SELECT COALESCE(json_agg(json_build_object('network', network, 'revenue', revenue, 'orders', orders) ORDER BY revenue DESC), '[]'::json)
    INTO v_by_network
    FROM (
        SELECT network, SUM(price) AS revenue, COUNT(*) AS orders
        FROM combined_orders_view
        GROUP BY network
    ) t;

    -- Revenue by product line (Data vs Airtime vs AFA vs Results Checker/Check)
    SELECT COALESCE(json_agg(json_build_object('product', product, 'revenue', revenue, 'orders', orders) ORDER BY revenue DESC), '[]'::json)
    INTO v_by_product
    FROM (
        SELECT 'Data' AS product, COALESCE(SUM(price), 0) AS revenue, COUNT(*) AS orders FROM combined_orders_view
        UNION ALL
        SELECT 'Airtime', COALESCE(SUM(total_paid), 0), COUNT(*) FROM airtime_orders WHERE status = 'completed'
        UNION ALL
        SELECT 'AFA', COALESCE(SUM(amount), 0), COUNT(*) FROM afa_orders WHERE status = 'completed'
        UNION ALL
        SELECT 'Results Checker', COALESCE(SUM(total_paid), 0), COUNT(*) FROM results_checker_orders WHERE payment_status = 'completed'
        UNION ALL
        SELECT 'Results Check', COALESCE(SUM(fee), 0), COUNT(*) FROM results_check_requests WHERE payment_status = 'completed'
    ) t
    WHERE revenue > 0;

    -- Revenue by order channel (Data orders only)
    SELECT COALESCE(json_agg(json_build_object('source', source, 'revenue', revenue, 'orders', orders) ORDER BY revenue DESC), '[]'::json)
    INTO v_by_source
    FROM (
        SELECT CASE type
            WHEN 'bulk' THEN 'Web'
            WHEN 'shop' THEN 'Shop'
            WHEN 'ussd' THEN 'Ussd'
            WHEN 'ussd_shop' THEN 'Ussd Shop'
            WHEN 'api' THEN 'Api'
            ELSE type
        END AS source, SUM(price) AS revenue, COUNT(*) AS orders
        FROM combined_orders_view
        GROUP BY type
    ) t
    WHERE revenue > 0;

    -- Top 5 packages by revenue (network + normalized size, across all Data order tables)
    SELECT COALESCE(json_agg(json_build_object('network', network, 'sizeGb', size_gb, 'revenue', revenue, 'orders', orders)), '[]'::json)
    INTO v_top_packages
    FROM (
        SELECT network,
            NULLIF(regexp_replace(volume_gb, '[^0-9.]', '', 'g'), '')::numeric AS size_gb,
            SUM(price) AS revenue, COUNT(*) AS orders
        FROM combined_orders_view
        WHERE volume_gb IS NOT NULL
        GROUP BY network, NULLIF(regexp_replace(volume_gb, '[^0-9.]', '', 'g'), '')::numeric
        ORDER BY SUM(price) DESC
        LIMIT 5
    ) t;

    -- Top 5 agents by revenue: real dealer/sub-agent shops only (excludes
    -- the platform's own house shop and direct customer bulk/api purchases,
    -- which have no store_name in the view)
    SELECT COALESCE(json_agg(json_build_object('shopName', shop_name, 'email', email, 'revenue', revenue, 'orders', orders)), '[]'::json)
    INTO v_top_agents
    FROM (
        SELECT us.shop_name, u.email, SUM(cov.price) AS revenue, COUNT(*) AS orders
        FROM combined_orders_view cov
        JOIN user_shops us ON us.user_id = cov.shop_owner_id AND us.shop_name = cov.store_name
        JOIN public.users u ON u.id = cov.shop_owner_id
        WHERE cov.store_name IS NOT NULL AND u.role IN ('dealer', 'sub_agent')
        GROUP BY us.shop_name, u.email
        ORDER BY SUM(cov.price) DESC
        LIMIT 5
    ) t;

    -- Growth & role mix
    SELECT COUNT(*) INTO v_new_7d FROM public.users WHERE created_at >= v_now - INTERVAL '7 days';
    SELECT COUNT(*) INTO v_new_30d FROM public.users WHERE created_at >= v_now - INTERVAL '30 days';
    SELECT COUNT(*) INTO v_expiring FROM user_subscriptions WHERE status = 'active' AND end_date >= v_now AND end_date < v_now + INTERVAL '7 days';

    SELECT COALESCE(json_agg(json_build_object('role', role, 'count', count)), '[]'::json)
    INTO v_role_mix
    FROM (
        SELECT role, COUNT(*) AS count FROM public.users GROUP BY role ORDER BY COUNT(*) DESC
    ) t;

    SELECT json_build_object(
        'byNetwork', v_by_network,
        'byProduct', v_by_product,
        'bySource', v_by_source,
        'topPackages', v_top_packages,
        'topAgents', v_top_agents,
        'growth', json_build_object(
            'new7d', v_new_7d,
            'new30d', v_new_30d,
            'expiring', v_expiring,
            'roleMix', v_role_mix
        )
    ) INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
