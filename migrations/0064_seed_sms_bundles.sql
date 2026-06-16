-- Initial SMS bundle tiers (admin can edit/add via /admin/sms). Idempotent: seeds only
-- when the table is empty, so re-running never duplicates (sms_bundles has no natural key).
INSERT INTO sms_bundles (name, units, price_ghs, owner_type_scope, active)
SELECT * FROM (VALUES
  ('Starter - 1,000 SMS',  1000,  35.00, 'all', true),
  ('Growth - 5,000 SMS',   5000, 150.00, 'all', true),
  ('Scale - 20,000 SMS',  20000, 520.00, 'all', true)
) AS v(name, units, price_ghs, owner_type_scope, active)
WHERE NOT EXISTS (SELECT 1 FROM sms_bundles);
