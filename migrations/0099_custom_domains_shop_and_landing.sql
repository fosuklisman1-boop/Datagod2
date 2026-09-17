-- Custom domains can now be linked to an existing white-label shop (guest
-- checkout is inherent to a shop, so it fully replaces the dashboard for that
-- domain), or, for domains that stay in dashboard/account mode, toggle
-- whether the landing page renders at all and whether the guest-purchase
-- button shows on it. See
-- docs/superpowers/specs/2026-09-17-custom-domain-shop-and-landing-modes-design.md.

alter table custom_domains
  add column if not exists linked_shop_id uuid references user_shops(id) on delete set null,
  add column if not exists show_guest_purchase boolean not null default false,
  add column if not exists show_landing_page boolean not null default true;

create index if not exists idx_custom_domains_linked_shop_id on custom_domains(linked_shop_id);
