-- Migration to add RPCs for heavy admin calculations

-- 1. Admin Dashboard Stats
CREATE OR REPLACE FUNCTION get_admin_dashboard_stats()
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'totalUsers', (SELECT COUNT(*) FROM users),
        'totalShops', (SELECT COUNT(*) FROM user_shops),
        'totalSubAgents', (SELECT COUNT(*) FROM user_shops WHERE parent_shop_id IS NOT NULL),
        'totalOrders', (SELECT COUNT(*) FROM shop_orders),
        'totalRevenue', (SELECT COALESCE(SUM(total_price), 0) FROM shop_orders),
        'pendingShops', (SELECT COUNT(*) FROM user_shops WHERE is_active = false),
        'completedOrders', (SELECT COUNT(*) FROM shop_orders WHERE order_status = 'completed'),
        'totalWalletBalance', (SELECT COALESCE(SUM(balance), 0) FROM wallets),
        'totalProfitBalance', (SELECT COALESCE(SUM(available_balance), 0) FROM shop_available_balance)
    ) INTO result;
    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Order History Stats
CREATE OR REPLACE FUNCTION get_order_history_stats(
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL,
    p_network_filter TEXT DEFAULT 'all'
)
RETURNS JSON AS $$
DECLARE
    v_total_volume NUMERIC := 0;
    v_total_revenue NUMERIC := 0;
    v_total_orders BIGINT := 0;
BEGIN
    -- Volume and Revenue from Bulk Orders
    SELECT 
        COALESCE(SUM(size), 0),
        COALESCE(SUM(price), 0),
        COUNT(*)
    INTO v_total_volume, v_total_revenue, v_total_orders
    FROM orders
    WHERE 
        (p_date_from IS NULL OR created_at >= p_date_from) AND
        (p_date_to IS NULL OR created_at <= p_date_to) AND
        (p_network_filter = 'all' OR network ILIKE '%' || p_network_filter || '%');

    -- Add Volume and Revenue from Shop Orders
    DECLARE
        v_shop_volume NUMERIC;
        v_shop_revenue NUMERIC;
        v_shop_count BIGINT;
    BEGIN
        SELECT 
            COALESCE(SUM(volume_gb), 0),
            COALESCE(SUM(total_price), 0),
            COUNT(*)
        INTO v_shop_volume, v_shop_revenue, v_shop_count
        FROM shop_orders
        WHERE 
            payment_status = 'completed' AND
            (p_date_from IS NULL OR created_at >= p_date_from) AND
            (p_date_to IS NULL OR created_at <= p_date_to) AND
            (p_network_filter = 'all' OR network ILIKE '%' || p_network_filter || '%');
        
        v_total_volume := v_total_volume + v_shop_volume;
        v_total_revenue := v_total_revenue + v_shop_revenue;
        v_total_orders := v_total_orders + v_shop_count;
    END;

    RETURN json_build_object(
        'totalVolume', v_total_volume,
        'totalRevenue', v_total_revenue,
        'totalOrders', v_total_orders
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Profits History Stats
CREATE OR REPLACE FUNCTION get_profits_history_stats(
    p_shop_id UUID DEFAULT NULL,
    p_status TEXT DEFAULT '',
    p_start_date TIMESTAMPTZ DEFAULT NULL,
    p_end_date TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSON AS $$
BEGIN
    RETURN (
        SELECT json_build_object(
            'totalProfit', COALESCE(SUM(profit_amount), 0),
            'pendingProfit', COALESCE(SUM(CASE WHEN status = 'pending' THEN profit_amount ELSE 0 END), 0),
            'creditedProfit', COALESCE(SUM(CASE WHEN status = 'credited' THEN profit_amount ELSE 0 END), 0),
            'withdrawnProfit', COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN profit_amount ELSE 0 END), 0),
            'pendingCount', COUNT(*) FILTER (WHERE status = 'pending'),
            'creditedCount', COUNT(*) FILTER (WHERE status = 'credited'),
            'withdrawnCount', COUNT(*) FILTER (WHERE status = 'withdrawn'),
            'totalRecords', COUNT(*)
        )
        FROM shop_profits
        WHERE 
            (p_shop_id IS NULL OR shop_id = p_shop_id) AND
            (p_status = '' OR status = p_status) AND
            (p_start_date IS NULL OR created_at >= p_start_date) AND
            (p_end_date IS NULL OR created_at <= p_end_date)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Sub-Agent Earnings for Parent (Global & Breakdown)
CREATE OR REPLACE FUNCTION get_sub_agent_earnings_stats(p_parent_shop_id UUID)
RETURNS JSON AS $$
DECLARE
    v_total_earnings NUMERIC;
    v_total_orders BIGINT;
    v_breakdown JSON;
BEGIN
    SELECT 
        COALESCE(SUM(parent_profit_amount), 0),
        COUNT(*)
    INTO v_total_earnings, v_total_orders
    FROM shop_orders
    WHERE (shop_id IN (SELECT id FROM user_shops WHERE parent_shop_id = p_parent_shop_id) 
           OR parent_shop_id = p_parent_shop_id)
    AND payment_status = 'completed';

    SELECT json_agg(t) INTO v_breakdown FROM (
        SELECT 
            shop_id,
            COUNT(*) as total_orders,
            COALESCE(SUM(total_price), 0) as total_sales,
            COALESCE(SUM(parent_profit_amount), 0) as your_earnings
        FROM shop_orders
        WHERE (shop_id IN (SELECT id FROM user_shops WHERE parent_shop_id = p_parent_shop_id) 
               OR parent_shop_id = p_parent_shop_id)
        AND payment_status = 'completed'
        GROUP BY shop_id
    ) t;

    RETURN json_build_object(
        'totalEarnings', v_total_earnings,
        'totalOrders', v_total_orders,
        'breakdown', COALESCE(v_breakdown, '[]'::json)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
