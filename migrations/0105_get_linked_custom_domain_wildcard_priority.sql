-- This migration previously extended 0103's get_linked_custom_domain to also
-- consider wildcard-enabled domains (migration 0104) as a lower-priority
-- fallback, so a shop with no direct link would still resolve a wildcard
-- domain as its own canonical/shareable URL. That was reverted: the user
-- decided wildcard mode should affect REACHABILITY only (a shop's subdomain
-- of a wildcard domain still resolves and works when visited directly —
-- handled entirely separately by lib/custom-domain-lookup.ts's
-- resolveCustomDomain/wildcardShopExists and middleware.ts, untouched here),
-- never a shop's own canonical/share URL (lib/shop-service.ts's
-- getLinkedCustomDomain, shopOrigin(), and the canonical tag in
-- app/shop/[slug]/layout.tsx). A wildcard domain is a true alternate:
-- ROOT_DOMAIN stays canonical unless the shop is specifically linked.
--
-- So this function is back to being functionally identical to what 0103
-- originally defined (same join, same filter, same order/limit shape) —
-- only a single priority-1 branch, no union.

create or replace function get_linked_custom_domain(p_subdomain text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select cd.domain
  from custom_domains cd
  join user_shops us on us.id = cd.linked_shop_id
  where cd.is_active = true
    and us.subdomain = p_subdomain
  order by cd.created_at asc
  limit 1
$$;

grant execute on function get_linked_custom_domain(text) to anon, authenticated;
