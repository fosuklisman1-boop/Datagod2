-- Custom domains can now be linked to an existing white-label shop: every
-- request to that domain rewrites to the shop's storefront instead of the
-- dashboard (guest checkout is inherent to a shop, so it fully replaces the
-- dashboard/account-mode experience for that domain). Showing the
-- guest-purchase button and the landing page itself are already covered by
-- the existing hidden_pages column's "guest_purchase"/"landing_page" keys
-- (migration 0100) — no separate columns needed for those. See
-- docs/superpowers/specs/2026-09-17-custom-domain-shop-and-landing-modes-design.md.

alter table custom_domains
  add column if not exists linked_shop_id uuid references user_shops(id) on delete set null;

create index if not exists idx_custom_domains_linked_shop_id on custom_domains(linked_shop_id);
