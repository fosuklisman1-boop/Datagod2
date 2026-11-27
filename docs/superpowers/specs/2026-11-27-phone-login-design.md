# Phone-number login: design

Note: migration renumbered 0201 → 0202 on 2026-11-27 (clash with 0201_ai_voice_calls); already applied to prod.

**Date:** 2026-11-27
**Status:** draft for owner approval
**Chosen approach:** C: phone + password, plus a one-time SMS code on a new device

## 1. Intent

Customers should be able to sign in with the phone number on their account instead of their email. The owner's brief
is "as secure as possible". Phone login opens a wallet with real money in it, and phone numbers are much easier to
learn than emails or passwords (they are printed on storefronts, shared in WhatsApp groups and used as MoMo numbers).
So phone login has to be at least as hard to break into as email login, never easier.

## 2. Today (what this builds on)

- Login ([app/auth/login-form.tsx](../../../app/auth/login-form.tsx), [lib/auth.ts](../../../lib/auth.ts)) offers email +
  password (`supabase.auth.signInWithPassword` in the browser) and Google. The Expo app
  ([mobile/src/app/login.tsx](../../../mobile/src/app/login.tsx)) offers email + password only.
- The phone number is stored on `public.users.phone_number` (free text, as typed) with `phone_verified boolean`
  (migration 0053). Supabase's `auth.users.phone` is **not** used, so Supabase's native phone sign-in can't be switched
  on as-is.
- Signup already requires an SMS-verified phone. The shared OTP core is [lib/phone-otp.ts](../../../lib/phone-otp.ts):
  table `phone_otp_verifications`, 6-digit code, 10-minute expiry, 3 sends per phone per hour, the
  `bump_otp_attempts()` cap (6) and a `purpose` per flow. Send routes add their own per-IP Upstash caps.
- Phone helpers: [lib/phone-format.ts](../../../lib/phone-format.ts) (`ghanaSignificant`, `normalizeGhanaPhone`,
  `isValidGhanaMobile`).
- Security alerting: [lib/security-alerts.ts](../../../lib/security-alerts.ts) (`raiseSecurityAlert`) → /admin/security.
- Google-only accounts set a password via `/api/auth/set-password`, which needs a phone OTP.
- Users can't change their own phone number in the profile today.

**Live data (2026-11-27, counts only):** 3,763 accounts. 3,447 have a valid 9-digit Ghana number, 316 have none or a
bad one. **5 numbers are shared by 10 accounts**, and `check-phone` compares the raw string, so `0241…` and `241…` don't
count as duplicates.

## 3. Goals, non-goals, anti-goals

**Goals**
- On the web login page, a customer with a verified phone can sign in with phone + their existing password.
- On a device the account hasn't used before, a 6-digit SMS code to the account's **registered** number is required
  before any session exists. After that the device is trusted for 30 days.
- Phone login can't be used to find out which numbers are registered (enumeration) or to flood a number with SMS.
- Admins can switch the whole feature on and off, and switch the new-device code off on its own if SMS delivery fails.
- Login attacks raise security alerts the same way other attacks do.

**Non-goals (v1)**
- Passwordless "SMS code only" login (approach B, rejected: SIM swap = wallet takeover).
- Phone login in the Expo mobile app (v2: it needs a device token in SecureStore in place of a cookie; see §9).
- Adding the new-device code to **email** login in phase 1. That is phase 2 (§10).
- USSD / WhatsApp bot identity: they already key on phone and are unchanged.
- Migrating phone numbers into Supabase `auth.users.phone`.

**Anti-goals (a failure even if it "works")**
- Any response that differs between "number not registered", "wrong password", "number not eligible" and "locked".
- A session or refresh token reaching the browser before the SMS code is accepted on an untrusted device.
- Sending the code to a number the caller typed instead of the number on the account.
- Phone numbers, codes, passwords or device tokens in logs (PII-free logs rule).
- Locking people out of email login when phone login or SMS has problems.

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Phone + password | No SMS cost, but a leaked or guessed password plus a widely known phone number is enough to get in | Dropped: weaker than C for little gain |
| B | Phone + SMS code, no password | Easiest for customers. But SIM swap = wallet takeover, one SMS per login, and easy to abuse by flooding a number with codes | Rejected: against "as secure as possible" |
| **C** | **Phone + password, plus an SMS code on a new device (30-day trust)** | An attacker needs both the password and the SIM. About one SMS per new device. If SMS is down, new devices can't use phone login (email still works) | **Owner picked C (2026-11-27)** |

## 5. User flow

```
Login page:  [ Email | Phone ] tabs (Phone hidden while the switch is off)

Phone tab:   Phone number  [ 024 123 4567 ]
             Password      [ •••••••• ]
             [ Sign in ]

  ├─ trusted device + correct password ─────────────► signed in → redirect (safeRedirectPath)
  ├─ new device + correct password ─► "We sent a code to 024 *** **67"
  │                                     Code [ ______ ]  [ Verify ]   (Resend in 60 s)
  │                                     ├─ correct ► signed in, device trusted 30 days
  │                                     └─ wrong ×6 / expired ► start again
  └─ anything else ─────────────────► "Phone number or password is incorrect."
```

- Only the last 2 digits of the number are shown on the code screen.
- "Forgot password?" on the phone tab leads to the existing reset flow (email). Phone-based reset is out of scope.
- The phone tab carries the same `?redirect=` handling as the email tab (`safeRedirectPath`).

## 6. Design

### 6.1 Eligibility (server-side, never revealed to the caller)

An account can use phone login only if all of these hold:
1. The normalized 9-digit number (`ghanaSignificant`) matches **exactly one** `public.users` row.
2. That row has `phone_verified = true`.
3. `users.is_suspended` is not true. (Admin suspension also sets a Supabase auth ban, so the password check fails
   anyway. This rule is belt and braces.)
4. The auth user has a password. *Builder call:* no separate check. A Google-only account simply fails the password
   check and gets the generic error, until the user sets a password through the existing set-password flow.

Any failure takes the same path as a wrong password: same message, same status code, and roughly the same response
time.

### 6.2 Step 1: `POST /api/auth/phone-login`  `{ phone, password }`

1. Rate limits:
   - per IP: 10 attempts / 15 min (Upstash, with the existing Postgres limiter fallback).
   - per phone: 5 failed attempts / 15 min → that phone is locked for 15 min. *Design call:* this counter lives in
     **Postgres**, not Upstash, so lockouts survive a Redis outage. Table `phone_login_failures` is keyed by
     `sha256(normalized phone)`, so no raw numbers are stored. Failures are counted for **unregistered numbers too**,
     so a lockout can't be used to tell registered numbers apart. Rows older than 1 day are deleted by the retention
     job (§6.6). A locked phone returns the generic error (no "locked" message).
   - If both limiters are unavailable, phone login **fails closed** (generic "try again later"). Email login is not
     affected.
2. Resolve the account with the service-role client by normalized number (needs an index; see §6.6).
3. If the account isn't eligible, run a dummy password check so the timing matches, then return the generic error.
4. Check the password with a **server-side, non-persisting** Supabase anon client:
   `signInWithPassword({ email: <resolved email>, password })`. The email never leaves the server.
5. Wrong password → count the failure, return the generic error.
6. Correct password:
   - **Device trusted** (valid `dg_device` cookie whose hash matches an unexpired, unrevoked `trusted_devices` row for
     this user) → return the session (see §6.4) and bump `last_used_at`.
   - **Device not trusted** and the new-device switch ON → **revoke the session step 4 just created** so nothing
     usable exists. *Design call:* `auth.admin.signOut(<that access token>, 'local')`. It must be **local** scope:
     the default global scope would log the real owner out of every device each time someone types their correct
     password, which gives an attacker a way to force them out. The plan's first task is a test confirming that local
     sign-out kills only that session. Create a login challenge (§6.3), issue an OTP with purpose
     `phone_login` to the **registered** number, and return `{ challengeId, maskedPhone }`.
   - New-device switch OFF → return the session (behaves like approach A) and log it as an unchallenged login.

### 6.3 Step 2: `POST /api/auth/phone-login/verify`  `{ challengeId, code }`

- A challenge row (`phone_login_challenges`): random id (≥128 bits), `user_id`, `ip_hash`, `ua_hash`, `created_at`,
  `expires_at` (10 min), `consumed_at`. It is bound to the **same browser** by an httpOnly, SameSite=Lax, Secure
  cookie `dg_plc` holding a random secret whose hash is stored on the row. A stolen `challengeId` alone is useless.
- The OTP row is keyed on the **canonical** `normalizeGhanaPhone()` form (`0XXXXXXXXX`) of the registered number on
  `user_id`. The same canonical string is used for issuing, checking and the 3-per-hour send cap, so mixed formats
  can't get around the cap.
- *Design call:* wrong-code attempts are counted **on the challenge row** (`attempts` column, cap 5 → challenge
  dead), not through the shared `bump_otp_attempts()` counter. That counter is phone-wide and anyone can hit it via the
  public `/api/auth/verify-phone-otp`, so a stranger could burn a real user's login attempts. The code match itself
  still uses the `phone_otp_verifications` row (purpose `phone_login`). Per-IP cap: 10 / 15 min. (The shared counter
  has the same weakness for signup today; that's a separate fix and not in v1.)
- Correct code → mark the challenge consumed (single use, atomic `update … where consumed_at is null`), mint a session
  for `user_id` **server-side** (builder's choice: `auth.admin.generateLink({type:'magiclink'})` + server
  `verifyOtp({token_hash})` is the expected path; anything works as long as no password is re-sent and no token is
  emailed), set the trusted-device cookie, and return the session.
- Resend: `POST /api/auth/phone-login/resend { challengeId }`. It needs the `dg_plc` cookie, waits 60 s between sends,
  and the core's existing limit of 3 sends per hour per phone still applies.

### 6.4 Handing the session to the browser

Same as the email flow: the route returns `{ access_token, refresh_token }` and the client calls
`supabase.auth.setSession()` (the browser client is `createBrowserClient` from `@supabase/ssr`, so this writes the same
cookies email login does), then redirects. Responses carry `Cache-Control: no-store`.

### 6.5 Trusted devices

- Table `trusted_devices`: `id`, `user_id`, `token_hash` (SHA-256 of a 256-bit random token), `created_at`,
  `last_used_at`, `expires_at` (created + 30 days, **not** sliding), `revoked_at`, `ua_label` (short browser/OS label for
  a future "your devices" list; no raw UA, no IP).
- Cookie `dg_device`: the raw token, httpOnly, Secure, SameSite=Lax, Max-Age 30 days, set per domain. Storefront custom
  domains get their own cookie, which is fine.
- **Revoke all** of a user's trusted devices on: password reset, password change, set-password, any phone-number
  change (admin or future self-service), and admin suspension. *Design call:* enforce this in the **database**, not
  route by route, because password change happens in the browser (`supabase.auth.updateUser`) and has no server hook.
  - a trigger on `auth.users` when `encrypted_password` changes, or when `banned_until` is set
  - a trigger on `public.users` when `phone_number` changes or `is_suspended` becomes true

  Each trigger sets `revoked_at` on that user's rows. The migration selftest covers each trigger.
- Cap: at most 10 active devices per user. The oldest is revoked when an 11th is added.

### 6.6 Data and migration (next free number on main)

- `phone_login_challenges` (incl. `attempts`, `otp_phone`), `trusted_devices`, `phone_login_failures` as above. RLS **on**, **no** grants to `anon`/`authenticated` (service
  role only), consistent with the RLS grant model.
- An expression index (or a stored generated column + index) on the 9-digit normalized form of `users.phone_number`.
- Settings keys in `admin_settings` (key/value table, **not** `app_settings`): `phone_login_enabled` (default
  **false**, so it ships dark), `phone_login_new_device_code` (default **true**).
- A retention job: delete challenges older than 1 day and devices expired or revoked more than 30 days ago. Fold this
  into an existing cleanup cron if there is one.

### 6.7 Closing the duplicate-number hole

- `/api/auth/check-phone` compares **normalized** numbers, so new signups can't create `0241…`/`241…` twins.
- The 5 existing shared numbers (10 accounts) are left alone. §6.1 rule 1 keeps them out of phone login, and the
  generic error points them at email. An admin list of those numbers is a nice-to-have, not v1.

### 6.8 Admin

- On the existing security or settings admin page, two toggles (the feature, and the new-device code) and simple
  counts for the last 24 h: phone logins, challenges sent, challenges passed, lockouts.
- Turning the new-device code **off** raises a security alert (it weakens protection).

### 6.9 Security alerts (`raiseSecurityAlert`)

- One IP tries more than 20 distinct phones in 15 min (credential stuffing).
- More than 10 phone lockouts in 15 min site-wide.
- A challenge passes for an account whose password was reset in the last 24 h. This is info level, a possible
  takeover signal.

### 6.10 SMS wording

`Datagod sign-in code: 123456. Someone is signing in to your account on a new device. If this isn't you, don't share
this code and change your password.` Builder: keep it to one SMS segment if possible, and route it through the same
SMS category as the existing phone OTP.

## 7. Abuse cases (fraud-first pass)

| Attack | Defence |
|---|---|
| Find out which numbers are registered | Identical message, status and timing for every failure; dummy password check |
| Password spraying across many numbers | Per-IP cap + per-phone lockout + stuffing alert |
| Leaked password, attacker on own device | SMS code to the registered SIM is still required on phone login; on email login from phase 2 |
| SIM swap only, no password | Password is still required (unlike approach B) |
| SIM swap + leaked password | Not covered by phone login alone. Mitigations: 30-day trust expiry, password-reset alert, revoke-all on reset. Same exposure as today's email login + reset-by-OTP |
| Flooding a victim with codes | Code sent only **after** a correct password; 3/hour/phone cap; 60 s resend gap |
| Stolen challengeId | Bound to the `dg_plc` browser cookie; single use; 10-min expiry |
| Code guessing | Existing 6-attempt cap per phone + per-IP cap |
| Stolen device cookie | Stored hashed; 30-day hard expiry; revoked on password change; useless without the password |
| Code redirected to the attacker's number | Code always goes to `users.phone_number` read server-side, never to request input |
| Lockout used to block a victim | Lockout is phone-login only, 15 min; email login is unaffected |
| Admin turns the code check off | Raises a security alert |

## 8. Testing (TDD, logic in `lib/`)

- `lib/phone-login/` holds the pure functions: eligibility, lockout decision, challenge checks, trusted-device
  checks, masked phone. Unit tests use the fake-client pattern with unique test phones.
- Route tests: every failure branch returns the same body, status and timing class; no session on the new-device
  path; challenge single use; wrong browser cookie rejected; revoke-all on password reset.
- Migration selftest in PGlite: RLS on, no anon/authenticated grants, normalized index used.
- Fresh-reviewer gate (auth + schema): a security reviewer on the finished diff before merge.
- Live check (owner, real phone): trusted path, new-device path, wrong password ×5 lockout, email login unchanged.

## 9. Left to the builder

- The exact mechanism for minting the post-OTP session (§6.3) and for revoking the step-1 session.
- Which suspension/ban columns exist (§6.1 rule 3).
- Where the admin toggles live (§6.8). Prefer an existing settings or security page over a new page.
- Login-form layout. Follow `docs/ui-conventions.md` and keep navy as the accent.
- v2 (not now): Expo app phone login with a SecureStore device token, a "your devices" list with sign-out-device on
  the profile page, and an admin list of shared numbers.

## 10. Phase 2: new-device code on email login (owner decision, 2026-11-27)

The owner chose to close the "log in by email to skip the code" path in a **second phase**, after phase 1 (everything
above) is live and proven.

- Email + password moves from the browser-side `signInWithPassword` to a server route that reuses the phase-1
  machinery: password check → trusted device? → otherwise revoke the session (local) + challenge + SMS code to the
  registered number.
- It sits behind its own `admin_settings` switch, `email_login_new_device_code` (default **false**).
- Accounts with no valid or verified phone (316 today, plus the 10 on shared numbers) can't receive a code. *Design
  call:* they keep plain email login and are counted on the admin page, so the owner can chase them to verify a
  number. Locking them out would be worse.
- Google sign-in is unchanged (Google runs its own device checks).
- The phase-1 build should keep the challenge/trust logic independent of how the account was identified, so phase 2
  only adds a route and a form change.

Until phase 2 is on, the security of the account as a whole is still bounded by email + password. Phase 1 makes phone
login itself no weaker than that.
