-- lib/shop-service.ts's getLinkedCustomDomain needs to answer "is this shop
-- linked to an active custom domain?" from the BROWSER client (anon or
-- authenticated), which can never read user_shops.id directly (no anon/
-- authenticated column grant exists on it — confirmed live). A plain
-- embedded-join select (custom_domains -> user_shops via linked_shop_id)
-- fails outright for anon with "permission denied for table user_shops",
-- since the join's underlying condition needs user_shops.id regardless of
-- whether it's ever returned to the client. A SECURITY DEFINER function
-- does the id-based join with the function owner's privileges internally,
-- exposing only the single derived domain string — the standard pattern
-- for "the client needs a derived answer but can't read the inputs."

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
