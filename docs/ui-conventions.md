# UI conventions

## Sidebar NEW tag

Rule (owner, 2026-10-13): whenever something new appears in the sidebar it gets a
**NEW** tag. The tag stays visible after the first click and disappears for good on
the user's **second** click of that item. Clicks are stored on the user's account,
so a cleared tag stays cleared on every device.

### How to tag a new nav item

1. Add its exact `href` to `NEW_NAV_ITEMS` in `lib/nav-new.ts` with today's date:
   `"/dashboard/thing": { since: "2026-11-01" }`.
2. Customer items (`menuItems` / `shopItems` in `lib/dashboard-nav-items.ts`): nothing
   else to do; the sidebar already renders the tag and counts clicks for them.
3. Admin items in `components/layout/sidebar.tsx` are hand-written links. Copy the
   pattern on the `/admin/sms` link: call `markClicked(href)` in the link's `onClick`
   (before `handleNavigation`), add `relative` to the Button, render `<NewTag />` beside
   the label when expanded and `<NewTag compact />` (a dot) when collapsed.
4. Prune registry entries after ~60 days. Old rows in `user_nav_clicks` are harmless
   (the API only returns hrefs that are still in the registry).

The mobile bottom bar (`bottom-nav.tsx`) never shows tags; the mobile drawer is the
same `Sidebar` component, so it shows them.

### Moving parts

| Piece | Where |
| --- | --- |
| Registry + pure logic (`isNavNew`, `recordNavClick`, payload parsing) | `lib/nav-new.ts` (tests: `lib/nav-new.test.ts`) |
| Table `user_nav_clicks (user_id, href, clicks 0..2)` + atomic `nav_click(user, href)` | `migrations/20261025_user_nav_clicks.sql` (service-role only, RLS on, no policies) |
| API | `GET /api/user/nav-new` -> `{ success, data: { clicks } }`; `POST { href }` -> `{ success, data: { href, clicks } }` (registry hrefs only, 60/min per user) |
| Client hook | `components/layout/use-nav-new.ts` (`useNavNew(userId)` -> `isNew`, `markClicked`) |
| Pill / dot | `components/layout/new-tag.tsx` |

Behaviour notes:

- No tag is rendered until the GET answers (SSR-safe, and no flash on items the user
  already cleared elsewhere). Any GET failure shows **no** tags, so deploying the code
  before the migration is harmless.
- Clicks are optimistic and POSTed fire-and-forget; they never block navigation.
- A click counts only while the tag is visible; clicking the active page counts too.
