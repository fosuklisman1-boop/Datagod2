-- DRY RUN: Identify debt recovery opportunities from shop profits
WITH UserDebt AS (
    SELECT 
        u.id as user_id,
        u.email,
        w.balance as wallet_balance,
        us.id as shop_id,
        us.shop_name
    FROM users u
    JOIN wallets w ON u.id = w.user_id
    JOIN user_shops us ON u.id = us.user_id
    WHERE w.balance < 0
),
ShopProfit AS (
    SELECT 
        shop_id,
        COALESCE(SUM(profit_amount), 0) as available_profit
    FROM shop_profits
    WHERE status IN ('pending', 'credited')
    GROUP BY shop_id
)
SELECT 
    ud.email,
    ud.shop_name,
    ABS(ud.wallet_balance) as amount_owing,
    sp.available_profit as available_profit,
    LEAST(ABS(ud.wallet_balance), sp.available_profit) as recoverable_amount,
    CASE 
        WHEN sp.available_profit >= ABS(ud.wallet_balance) THEN 'Full Recovery Possible'
        WHEN sp.available_profit > 0 THEN 'Partial Recovery Possible'
        ELSE 'No Profit Available'
    END as status
FROM UserDebt ud
LEFT JOIN ShopProfit sp ON ud.shop_id = sp.shop_id
WHERE sp.available_profit > 0
ORDER BY recoverable_amount DESC;
