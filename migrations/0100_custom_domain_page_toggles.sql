-- Lets an admin hide, per custom domain, any of the 13 toggleable
-- pages/features defined in lib/custom-domain-pages.ts. See
-- docs/superpowers/specs/2026-10-01-custom-domain-page-toggles-design.md.
--
-- The default array is deliberately NOT empty: the 9 dealer-tool keys are
-- currently always hidden on every custom domain (hardcoded in the
-- now-deleted NON_SERVICE_GATED_PATHS), while the other 4 keys
-- (landing_page, guest_purchase, join_channel, wallet) are currently
-- always shown (never gated at all). Postgres applies a new column's
-- default to every EXISTING row, not just future inserts, so every
-- current domain ends up with exactly today's behavior.
alter table custom_domains add column if not exists hidden_pages text[] not null default
  '{afa_orders,upgrade,my_shop,shop_dashboard,sub_agents,sub_agent_catalog,ussd_shop,payment_reverify,buy_stock}';
