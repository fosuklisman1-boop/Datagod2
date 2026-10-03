-- Lets an admin turn a custom domain into a shared, platform-wide
-- storefront host: when true, every active, non-blocked shop automatically
-- becomes reachable as <that shop's own subdomain>.<this domain> (see
-- lib/custom-domain-lookup.ts's resolveCustomDomain and migration 0105's
-- updated get_linked_custom_domain). Mutually exclusive with linked_shop_id
-- (migration 0101) — enforced only in app/api/admin/custom-domains/route.ts,
-- not with a DB CHECK constraint, to keep this column a simple additive
-- change.
alter table custom_domains
  add column if not exists wildcard_shops_enabled boolean not null default false;
