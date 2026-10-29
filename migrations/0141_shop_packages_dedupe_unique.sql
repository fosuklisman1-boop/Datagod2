-- shop_packages had no UNIQUE(shop_id, package_id), so the same package could be
-- saved several times per shop (re-adding it, and the sub-agent order path that
-- inserted a fresh copy whenever its .single() lookup hit duplicates). Duplicates
-- made shop USSD / WhatsApp confirm fail with "Package no longer available".
--
-- This keeps ONE row per (shop_id, package_id), repoints every order at it,
-- deletes the copies and adds the unique index so they can't come back.
--
-- Keeper = an available row over an unavailable one, then the most recently
-- updated (the row the app has priced with since the dedupe fix), then newest.
--
-- Before running, check nothing else references shop_packages (only
-- shop_orders.shop_package_id is known); add an UPDATE below for any other:
--   select conrelid::regclass as tbl, conname
--   from pg_constraint where confrelid = 'public.shop_packages'::regclass and contype = 'f';

begin;

create temporary table shop_packages_dedupe on commit drop as
select id, keeper_id
from (
  select
    id,
    first_value(id) over (
      partition by shop_id, package_id
      order by coalesce(is_available, false) desc,
               updated_at desc nulls last,
               created_at desc nulls last,
               id desc
    ) as keeper_id
  from public.shop_packages
) ranked
where id <> keeper_id;

-- Orders keep pointing at the same shop + package, just the surviving row.
update public.shop_orders o
set shop_package_id = d.keeper_id
from shop_packages_dedupe d
where o.shop_package_id = d.id;

delete from public.shop_packages p
using shop_packages_dedupe d
where p.id = d.id;

create unique index if not exists shop_packages_shop_id_package_id_key
  on public.shop_packages (shop_id, package_id);

commit;
