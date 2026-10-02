-- Extends migration 0103's get_linked_custom_domain to also consider
-- wildcard-enabled domains (migration 0104): every active, non-blocked
-- shop's own subdomain automatically resolves under such a domain, with
-- the shop's own direct link (if any) always taking priority, then the
-- oldest active row winning any further tie. Same SECURITY DEFINER
-- signature as 0103 — only the body changes, so no TypeScript call site
-- needs any change at all.

create or replace function get_linked_custom_domain(p_subdomain text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select domain from (
    -- Priority 1: this shop is specifically linked to an active domain.
    select cd.domain, cd.created_at, 1 as priority
    from custom_domains cd
    join user_shops us on us.id = cd.linked_shop_id
    where cd.is_active = true and us.subdomain = p_subdomain

    union all

    -- Priority 2: any active domain has wildcard mode on — every active,
    -- non-blocked shop is automatically reachable under it, so the
    -- caller's own subdomain being active is enough; no shop-specific
    -- match needed.
    select cd.domain, cd.created_at, 2 as priority
    from custom_domains cd
    where cd.is_active = true and cd.wildcard_shops_enabled = true
  ) ranked
  order by priority asc, created_at asc
  limit 1
$$;

grant execute on function get_linked_custom_domain(text) to anon, authenticated;
