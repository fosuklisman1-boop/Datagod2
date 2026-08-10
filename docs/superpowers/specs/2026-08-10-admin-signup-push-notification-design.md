# Admin Push Notification on New Signup — Design

## Goal

Notify all admins via push notification when a new user completes signup.

## Context

- `notifyAdminsPush(payload: PushPayload)` (`lib/push-service.ts:119-134`) already exists: sends a push notification to every `role='admin'` user, cleaning up dead subscriptions along the way. Already used the same fire-and-forget way for other admin alerts (e.g. `lib/mtn-reversal.ts`, `lib/mtn-fulfillment.ts`).
- Signup is two-phase: a DB trigger (`handle_new_user`, `migrations/0058_auto_create_user_profile.sql`) creates a bare `public.users` row the instant an `auth.users` row is inserted (phone_number NULL, unonboarded); `POST /api/auth/signup` (`app/api/auth/signup/route.ts`) later completes it — verifies phone OTP, fills in the profile, creates a wallet, and sends a welcome email. The app's own definition of "onboarded" is `phone_number IS NOT NULL`, i.e. the second phase.
- `app/admin/users/page.tsx` exists as the admin user list — the natural link target.

## Design

Add one `notifyAdminsPush()` call inside `app/api/auth/signup/route.ts`, fired when the profile upsert + wallet creation succeed — i.e. exactly when "signup completes" in this app's own sense. Placed alongside the existing welcome-email send (same fire-and-forget, non-blocking style: don't `await` inline in the main response path, `.catch()` any failure so a push-delivery problem can never break signup itself).

Fires unconditionally regardless of the account's assigned role (`user` or `dealer` — `defaultRole` per `admin_settings.signup_default_role`).

```ts
notifyAdminsPush({
  title: "🆕 New Signup",
  body: `${firstName || "Someone"} ${lastName || ""}`.trim() + ` just signed up (${phoneNumber})`,
  data: { url: "/admin/users" },
}).catch(err => console.error("[SIGNUP] Admin push notification failed:", err))
```

No preference/settings toggle, no throttling or digest batching — matches how every other admin push notification in this codebase already behaves (per-event, always-on).

## Out of scope

- Notifying on the FIRST phase (bare auth-account creation before phone verification) — explicitly not what was asked for; would require a DB-trigger-driven webhook (like the existing security-alerting pg_net system) rather than a simple API-route call.
- Any admin-configurable on/off toggle for this specific notification — none of the existing admin push notifications in this codebase have one, so adding one here would be inconsistent, not requested, and not worth the extra `admin_settings` plumbing for a single notification type.
