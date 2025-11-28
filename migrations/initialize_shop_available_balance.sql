-- Initialize shop_available_balance table with existing data
-- Run this after creating the shop_available_balance table

-- Clear existing data to avoid duplicates
DELETE FROM shop_available_balance;

-- Insert data from shop_profits
INSERT INTO shop_available_balance (shop_id, available_balance, total_profit, withdrawn_amount, pending_profit, credited_profit, withdrawn_profit, created_at, updated_at)
SELECT 
  sp.shop_id,
  SUM(CASE WHEN sp.status IN ('pending', 'credited') THEN sp.profit_amount ELSE 0 END) as available_balance,
  SUM(sp.profit_amount) as total_profit,
  SUM(CASE WHEN sp.status = 'withdrawn' THEN sp.profit_amount ELSE 0 END) as withdrawn_amount,
  SUM(CASE WHEN sp.status = 'pending' THEN sp.profit_amount ELSE 0 END) as pending_profit,
  SUM(CASE WHEN sp.status = 'credited' THEN sp.profit_amount ELSE 0 END) as credited_profit,
  SUM(CASE WHEN sp.status = 'withdrawn' THEN sp.profit_amount ELSE 0 END) as withdrawn_profit,
  NOW(),
  NOW()
FROM shop_profits sp
GROUP BY sp.shop_id;
