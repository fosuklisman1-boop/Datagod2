# Push Notifications — One-Time Setup

The mobile app's push code is fully wired but **dormant** until these three
manual steps are done. Nothing breaks while they're pending — registration
silently no-ops (see `src/lib/push.ts`).

## 1. Create the EAS project (free)

```bash
cd mobile
npx eas-cli init
```

Log in with (or create) a free Expo account. This writes
`extra.eas.projectId` into `app.json` — that ID is what
`getExpoPushTokenAsync` needs to mint tokens. Commit the `app.json` change.

## 2. Supabase Database Webhook

Supabase Dashboard → Database → Webhooks → **Create a new hook**:

| Setting | Value |
|---|---|
| Name | `push-dispatch` |
| Table | `public.notifications` |
| Events | `INSERT` only |
| Type | HTTP Request, `POST` |
| URL | `https://www.datagod.store/api/push/dispatch` |
| HTTP Headers | `x-push-webhook-secret: <the secret from step 3>` |

## 3. Vercel env var

Add `PUSH_WEBHOOK_SECRET` (any long random string, e.g. `openssl rand -hex 32`)
to the Vercel project env (Production), then redeploy. The dispatch endpoint
**fails closed** — it returns 401 to everyone until this is set.

## Testing

Expo Go **cannot receive remote pushes** (SDK 53+). To test end-to-end:

1. Build a free Android development build: `npx eas-cli build --profile development --platform android`,
   install the APK on an Android phone, sign in (this registers the token —
   check the `device_push_tokens` table).
2. Insert a row into `notifications` for your user (or trigger any real event,
   e.g. complete an order) and confirm the push arrives.

iOS pushes additionally require an Apple Developer account ($99/yr) — deferred.
