-- show_guest_purchase/show_landing_page were added by a since-abandoned
-- design (see 0101's comment) and were applied to prod by hand at some
-- point, but the application code that would have read/written them never
-- shipped — hidden_pages' own "guest_purchase"/"landing_page" keys (0100)
-- are what's actually enforced live. Confirmed dead: no code references
-- either column, and the only existing custom_domains row's values were
-- never read by any deployed code.

alter table custom_domains
  drop column if exists show_guest_purchase,
  drop column if exists show_landing_page;
