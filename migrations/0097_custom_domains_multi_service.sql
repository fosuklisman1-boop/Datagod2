-- Custom domains can now select multiple services (not just one) — a domain's
-- nav/routing shows the union of its selected services' content, plus bare
-- account-wide essentials, with everything else (AFA orders, dealer/shop
-- management tools, etc.) hidden and blocked.

alter table custom_domains add column if not exists services text[];

update custom_domains
  set services = array[service]
  where services is null;

alter table custom_domains
  add constraint custom_domains_services_valid
    check (services <@ array['data_bundles','airtime','results_checker','bulk_sms']::text[]),
  add constraint custom_domains_services_nonempty
    check (cardinality(services) > 0),
  alter column services set not null;

alter table custom_domains drop column service;
