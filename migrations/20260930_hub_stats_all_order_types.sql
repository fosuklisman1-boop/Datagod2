-- Fixes two real bugs found after shipping the Admin Dashboard hub:
--
-- 1. get_admin_dashboard_hub_stats' "Data" revenue/cost only queried
--    shop_orders, missing 4 of the 5 tables that make up Data revenue
--    (orders/bulk, api_orders/api, ussd_orders/ussd, ussd_shop_orders/
--    ussd_shop) -- undercounting real 7-day revenue by roughly half
--    (16,713 vs the real 32,109 across all 5 tables, verified live).
--    Now sourced from combined_orders_view (the same 5-table union
--    already used by get_admin_dashboard_analytics), which already
--    encodes the platform's established per-type completion convention
--    (bulk/api = all statuses, shop/ussd = payment_status=completed
--    only).
--
-- 2. get_admin_dashboard_analytics' breakdown panels (Revenue by
--    Network, By Product, By Source, Top Packages, Top Agents) were
--    all-time only, not scoped to the Today/7D/30D range picker. Now
--    takes the same p_range parameter as the hub stats RPC. Growth &
--    Roles (new users / expiring / role mix) stays a live snapshot,
--    not range-scoped, since those are shown as fixed dual windows
--    (New 7D + New 30D together) rather than a single toggled value.

CREATE OR REPLACE FUNCTION get_admin_dashboard_hub_stats(p_range TEXT DEFAULT '7d')
RETURNS JSON AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_start TIMESTAMPTZ;
    v_prev_start TIMESTAMPTZ;
    v_today_start TIMESTAMPTZ := date_trunc('day', v_now);

    v_cost_mtn NUMERIC := 0;
    v_cost_telecel NUMERIC := 0;
    v_cost_at_ishare NUMERIC := 0;
    v_cost_at_bigtime NUMERIC := 0;

    v_data_revenue NUMERIC := 0;
    v_data_orders BIGINT := 0;
    v_data_completed_orders BIGINT := 0;
    v_prev_data_revenue NUMERIC := 0;

    v_range_revenue NUMERIC := 0;
    v_prev_revenue NUMERIC := 0;
    v_range_payout NUMERIC := 0;
    v_range_supplier_cost NUMERIC := 0;
    v_range_profit NUMERIC := 0;

    v_range_total_orders BIGINT := 0;
    v_range_completed_orders BIGINT := 0;
    v_today_orders BIGINT := 0;

    v_float_balance NUMERIC := 0;
    v_debtors_total NUMERIC := 0;
    v_debtors_count BIGINT := 0;

    v_complaints_pending BIGINT := 0;
    v_afa_pending BIGINT := 0;
    v_agents_expiring BIGINT := 0;
    v_pending_shops BIGINT := 0;

    v_chart_series JSON;
    v_result JSON;
BEGIN
    -- Range window
    IF p_range = 'today' THEN
        v_start := v_today_start;
    ELSIF p_range = '30d' THEN
        v_start := v_now - INTERVAL '30 days';
    ELSE
        v_start := v_now - INTERVAL '7 days';
    END IF;
    v_prev_start := v_start - (v_now - v_start);

    -- Admin-configured supplier cost per GB (singleton config row)
    SELECT
        COALESCE(supplier_cost_per_gb_mtn, 0),
        COALESCE(supplier_cost_per_gb_telecel, 0),
        COALESCE(supplier_cost_per_gb_at_ishare, 0),
        COALESCE(supplier_cost_per_gb_at_bigtime, 0)
    INTO v_cost_mtn, v_cost_telecel, v_cost_at_ishare, v_cost_at_bigtime
    FROM app_settings WHERE key IS NULL LIMIT 1;

    -- Data revenue + order counts, current window (all 5 Data order tables)
    SELECT
        COALESCE(SUM(price), 0),
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed')
    INTO v_data_revenue, v_data_orders, v_data_completed_orders
    FROM combined_orders_view WHERE created_at >= v_start;

    SELECT COALESCE(SUM(price), 0) INTO v_prev_data_revenue
    FROM combined_orders_view WHERE created_at >= v_prev_start AND created_at < v_start;

    -- Revenue + order counts, current window (Data + the other 4 product lines)
    SELECT
        v_data_revenue
          + (SELECT COALESCE(SUM(total_paid), 0) FROM airtime_orders WHERE status = 'completed' AND created_at >= v_start)
          + (SELECT COALESCE(SUM(total_paid), 0) FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COALESCE(SUM(fee), 0) FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COALESCE(SUM(amount), 0) FROM afa_orders WHERE status = 'completed' AND created_at >= v_start),
        v_data_orders
          + (SELECT COUNT(*) FROM airtime_orders WHERE created_at >= v_start)
          + (SELECT COUNT(*) FROM results_checker_orders WHERE created_at >= v_start)
          + (SELECT COUNT(*) FROM results_check_requests WHERE created_at >= v_start)
          + (SELECT COUNT(*) FROM afa_orders WHERE created_at >= v_start),
        v_data_completed_orders
          + (SELECT COUNT(*) FROM airtime_orders WHERE status = 'completed' AND created_at >= v_start)
          + (SELECT COUNT(*) FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COUNT(*) FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COUNT(*) FROM afa_orders WHERE status = 'completed' AND created_at >= v_start)
    INTO v_range_revenue, v_range_total_orders, v_range_completed_orders;

    -- Same, previous equal-length window (for the % change indicator)
    SELECT
        v_prev_data_revenue
          + (SELECT COALESCE(SUM(total_paid), 0) FROM airtime_orders WHERE status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
          + (SELECT COALESCE(SUM(total_paid), 0) FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
          + (SELECT COALESCE(SUM(fee), 0) FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
          + (SELECT COALESCE(SUM(amount), 0) FROM afa_orders WHERE status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
    INTO v_prev_revenue;

    -- Shop-owner payouts in range (single ledger across every order type)
    SELECT COALESCE(SUM(profit_amount), 0) INTO v_range_payout
    FROM shop_profits WHERE status = 'credited' AND created_at >= v_start;

    -- Real supplier cost for Data volume sold in range, across all 5 Data
    -- order tables (volume_gb is stored inconsistently as text -- "2",
    -- "2.00", "2GB" -- normalized the same way as the analytics RPC)
    SELECT COALESCE(SUM(
        NULLIF(regexp_replace(volume_gb, '[^0-9.]', '', 'g'), '')::numeric * CASE network
            WHEN 'MTN' THEN v_cost_mtn
            WHEN 'Telecel' THEN v_cost_telecel
            WHEN 'AT - iShare' THEN v_cost_at_ishare
            WHEN 'AT - BigTime' THEN v_cost_at_bigtime
            ELSE 0
        END
    ), 0) INTO v_range_supplier_cost
    FROM combined_orders_view WHERE created_at >= v_start AND volume_gb IS NOT NULL;

    v_range_profit := v_range_revenue - v_range_payout - v_range_supplier_cost;

    -- Today's orders (always "today", independent of the selected range)
    SELECT
        (SELECT COUNT(*) FROM combined_orders_view WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM airtime_orders WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM results_checker_orders WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM results_check_requests WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM afa_orders WHERE created_at >= v_today_start)
    INTO v_today_orders;

    -- Float & Liability: wallets held for users vs. negative-balance debtors
    SELECT
        COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0),
        COALESCE(SUM(ABS(balance)) FILTER (WHERE balance < 0), 0),
        COUNT(*) FILTER (WHERE balance < 0)
    INTO v_float_balance, v_debtors_total, v_debtors_count
    FROM wallets;

    -- Quick-action counts
    SELECT COUNT(*) INTO v_complaints_pending FROM whatsapp_complaints WHERE status = 'pending';
    SELECT COUNT(*) INTO v_afa_pending FROM afa_orders WHERE status = 'pending';
    SELECT COUNT(*) INTO v_agents_expiring FROM user_subscriptions
        WHERE status = 'active' AND end_date >= v_now AND end_date < v_now + INTERVAL '7 days';
    SELECT COUNT(*) INTO v_pending_shops FROM user_shops WHERE is_active = false;

    -- Daily chart series (revenue + profit per day across the range)
    WITH days AS (
        SELECT generate_series(date_trunc('day', v_start), date_trunc('day', v_now), '1 day'::interval)::date AS d
    ),
    daily_data AS (
        SELECT date_trunc('day', created_at)::date d, SUM(price) rev
        FROM combined_orders_view WHERE created_at >= v_start GROUP BY 1
    ),
    daily_airtime AS (
        SELECT date_trunc('day', created_at)::date d, SUM(total_paid) rev
        FROM airtime_orders WHERE status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_rc AS (
        SELECT date_trunc('day', created_at)::date d, SUM(total_paid) rev
        FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_rcs AS (
        SELECT date_trunc('day', created_at)::date d, SUM(fee) rev
        FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_afa AS (
        SELECT date_trunc('day', created_at)::date d, SUM(amount) rev
        FROM afa_orders WHERE status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_payout AS (
        SELECT date_trunc('day', created_at)::date d, SUM(profit_amount) payout
        FROM shop_profits WHERE status = 'credited' AND created_at >= v_start GROUP BY 1
    ),
    daily_supplier_cost AS (
        SELECT date_trunc('day', created_at)::date d,
            SUM(NULLIF(regexp_replace(volume_gb, '[^0-9.]', '', 'g'), '')::numeric * CASE network
                WHEN 'MTN' THEN v_cost_mtn
                WHEN 'Telecel' THEN v_cost_telecel
                WHEN 'AT - iShare' THEN v_cost_at_ishare
                WHEN 'AT - BigTime' THEN v_cost_at_bigtime
                ELSE 0
            END) cost
        FROM combined_orders_view WHERE created_at >= v_start AND volume_gb IS NOT NULL GROUP BY 1
    ),
    combined AS (
        SELECT
            days.d,
            COALESCE(daily_data.rev, 0) + COALESCE(daily_airtime.rev, 0) + COALESCE(daily_rc.rev, 0) + COALESCE(daily_rcs.rev, 0) + COALESCE(daily_afa.rev, 0) AS revenue,
            COALESCE(daily_payout.payout, 0) AS payout,
            COALESCE(daily_supplier_cost.cost, 0) AS supplier_cost
        FROM days
        LEFT JOIN daily_data ON daily_data.d = days.d
        LEFT JOIN daily_airtime ON daily_airtime.d = days.d
        LEFT JOIN daily_rc ON daily_rc.d = days.d
        LEFT JOIN daily_rcs ON daily_rcs.d = days.d
        LEFT JOIN daily_afa ON daily_afa.d = days.d
        LEFT JOIN daily_payout ON daily_payout.d = days.d
        LEFT JOIN daily_supplier_cost ON daily_supplier_cost.d = days.d
    )
    SELECT json_agg(json_build_object(
        'date', to_char(d, 'YYYY-MM-DD'),
        'revenue', revenue,
        'profit', revenue - payout - supplier_cost
    ) ORDER BY d)
    INTO v_chart_series
    FROM combined;

    SELECT json_build_object(
        'range', p_range,
        'rangeRevenue', v_range_revenue,
        'rangeRevenuePrevious', v_prev_revenue,
        'rangeProfit', v_range_profit,
        'rangeOrders', v_range_total_orders,
        'rangeCompletedOrders', v_range_completed_orders,
        'rangeSuccessRate', CASE WHEN v_range_total_orders > 0 THEN ROUND((v_range_completed_orders::numeric / v_range_total_orders) * 100, 1) ELSE 0 END,
        'todayOrders', v_today_orders,
        'floatBalance', v_float_balance,
        'debtorsTotal', v_debtors_total,
        'debtorsCount', v_debtors_count,
        'complaintsPending', v_complaints_pending,
        'afaPending', v_afa_pending,
        'agentsExpiring', v_agents_expiring,
        'pendingShops', v_pending_shops,
        'actionsTotal', v_complaints_pending + v_afa_pending + v_agents_expiring + v_pending_shops + v_debtors_count,
        'chartSeries', COALESCE(v_chart_series, '[]'::json)
    ) INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


CREATE OR REPLACE FUNCTION get_admin_dashboard_analytics(p_range TEXT DEFAULT '7d')
RETURNS JSON AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_start TIMESTAMPTZ;
    v_today_start TIMESTAMPTZ := date_trunc('day', v_now);

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
    IF p_range = 'today' THEN
        v_start := v_today_start;
    ELSIF p_range = '30d' THEN
        v_start := v_now - INTERVAL '30 days';
    ELSE
        v_start := v_now - INTERVAL '7 days';
    END IF;

    -- Revenue by network (Data orders only, across all 5 source tables)
    SELECT COALESCE(json_agg(json_build_object('network', network, 'revenue', revenue, 'orders', orders) ORDER BY revenue DESC), '[]'::json)
    INTO v_by_network
    FROM (
        SELECT network, SUM(price) AS revenue, COUNT(*) AS orders
        FROM combined_orders_view
        WHERE created_at >= v_start
        GROUP BY network
    ) t;

    -- Revenue by product line (Data vs Airtime vs AFA vs Results Checker/Check)
    SELECT COALESCE(json_agg(json_build_object('product', product, 'revenue', revenue, 'orders', orders) ORDER BY revenue DESC), '[]'::json)
    INTO v_by_product
    FROM (
        SELECT 'Data' AS product, COALESCE(SUM(price), 0) AS revenue, COUNT(*) AS orders FROM combined_orders_view WHERE created_at >= v_start
        UNION ALL
        SELECT 'Airtime', COALESCE(SUM(total_paid), 0), COUNT(*) FROM airtime_orders WHERE status = 'completed' AND created_at >= v_start
        UNION ALL
        SELECT 'AFA', COALESCE(SUM(amount), 0), COUNT(*) FROM afa_orders WHERE status = 'completed' AND created_at >= v_start
        UNION ALL
        SELECT 'Results Checker', COALESCE(SUM(total_paid), 0), COUNT(*) FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_start
        UNION ALL
        SELECT 'Results Check', COALESCE(SUM(fee), 0), COUNT(*) FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_start
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
        WHERE created_at >= v_start
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
        WHERE volume_gb IS NOT NULL AND created_at >= v_start
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
        WHERE cov.store_name IS NOT NULL AND u.role IN ('dealer', 'sub_agent') AND cov.created_at >= v_start
        GROUP BY us.shop_name, u.email
        ORDER BY SUM(cov.price) DESC
        LIMIT 5
    ) t;

    -- Growth & role mix: deliberately NOT range-scoped -- shown as fixed
    -- dual windows (New 7D + New 30D together) and a live role-composition
    -- snapshot, independent of the Today/7D/30D toggle above.
    SELECT COUNT(*) INTO v_new_7d FROM public.users WHERE created_at >= v_now - INTERVAL '7 days';
    SELECT COUNT(*) INTO v_new_30d FROM public.users WHERE created_at >= v_now - INTERVAL '30 days';
    SELECT COUNT(*) INTO v_expiring FROM user_subscriptions WHERE status = 'active' AND end_date >= v_now AND end_date < v_now + INTERVAL '7 days';

    SELECT COALESCE(json_agg(json_build_object('role', role, 'count', count)), '[]'::json)
    INTO v_role_mix
    FROM (
        SELECT role, COUNT(*) AS count FROM public.users GROUP BY role ORDER BY COUNT(*) DESC
    ) t;

    SELECT json_build_object(
        'range', p_range,
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
