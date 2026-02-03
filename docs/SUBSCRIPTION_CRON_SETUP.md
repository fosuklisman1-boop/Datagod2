# Setting Up Subscription Expiry Cron Job

## Overview

The subscription expiry reminder system requires a cron job to run hourly and check for subscriptions that need reminders.

## Endpoint

`GET /api/cron/check-subscription-expiry`

## Setup Options

### Option 1: Vercel Cron (Recommended for Vercel deployments)

1. Create `vercel.json` in project root:

```json
{
  "crons": [{
    "path": "/api/cron/check-subscription-expiry",
    "schedule": "0 * * * *"
  }]
}
```

2. Add `CRON_SECRET` to environment variables in Vercel dashboard

3. Deploy - Vercel will automatically set up the cron job

### Option 2: External Cron Service (cron-job.org, EasyCron, etc.)

1. Set up hourly GET request to: `https://yourdomain.com/api/cron/check-subscription-expiry`

2. Schedule: Every hour (`0 * * * *`)

### Option 3: Server Cron (if self-hosting)

```bash
# Add to crontab
0 * * * * curl https://yourdomain.com/api/cron/check-subscription-expiry
```

## Database Setup

Run the migration file to create the `subscription_reminders` table:

```bash
# Execute SQL in Supabase SQL Editor or via CLI
psql -f migrations/create_subscription_reminders.sql
```

## Testing

Test the endpoint locally:

```bash
curl http://localhost:3000/api/cron/check-subscription-expiry
```

Expected response:
```json
{
  "success": true,
  "checked": 5,
  "sent": 2,
  "skipped": 3,
  "errors": 0
}
```

## Monitoring

Check logs for:
- `[CRON-SUBSCRIPTION]` entries
- Monitor `subscription_reminders` table for sent reminders
- Verify SMS logs in `sms_logs` table
