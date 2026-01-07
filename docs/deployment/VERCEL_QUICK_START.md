# Vercel Quick Deploy Guide

## 5-Minute Setup

### Step 1: Prepare Repository (Already Done ✓)
```bash
git push origin main
```

### Step 2: Create Vercel Project
1. Go to https://vercel.com/new
2. Import **fosuklisman1-boop/Datagod2** repository
3. Framework preset: **Next.js** (auto-detected)
4. Click Deploy

### Step 3: Add Environment Variables
After project creation, go to **Settings → Environment Variables**:

```
NEXT_PUBLIC_SUPABASE_URL=your_url_here
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_key_here
NEXT_PUBLIC_APP_URL=your_production_url_here
```

### Step 4: Redeploy
- Go to Deployments tab
- Click three dots on failed deployment (if any)
- Select "Redeploy"
- Or push a new commit to trigger automatic deployment

### Step 5: Verify
- Visit your production URL
- Test login/signup flow
- Check admin dashboard for errors

## Environment Variables Detail

| Variable | Source | Example |
|----------|--------|---------|
| NEXT_PUBLIC_SUPABASE_URL | Supabase Dashboard | `https://xxx.supabase.co` |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Supabase Settings | `eyJhbGc...` |
| SUPABASE_SERVICE_ROLE_KEY | Supabase Settings (Private) | `eyJhbGc...` |
| NEXT_PUBLIC_APP_URL | Vercel assigned domain | `https://datagod.vercel.app` |

## Get Environment Variables from Supabase

1. Log in to [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Go to **Settings → API**
4. Copy:
   - **URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret** → `SUPABASE_SERVICE_ROLE_KEY`

## Custom Domain (Optional)

1. In Vercel: Settings → Domains
2. Enter your domain (e.g., datagod.app)
3. Update your domain provider's DNS records
4. Wait for verification (usually instant)

## Auto-Deploy on Git Push

Vercel automatically deploys when you:
- Push to main branch
- Create a pull request (preview deployment)
- Manually trigger from dashboard

No additional setup needed!

## Verify Everything Works

### Test Endpoints
```bash
curl https://your-domain.com/api/health
```

### Check Logs
- Vercel: Dashboard → Deployments → Select deployment → Logs
- Real-time function logs shown instantly

### Monitor Performance
- Vercel Analytics: Dashboard → Analytics
- Supabase Dashboard: Logs → API requests

## Troubleshooting

| Error | Solution |
|-------|----------|
| 500 errors on API | Check env vars in Vercel Settings |
| Build fails | Verify .vercelignore exists |
| Pages load blank | Check browser console for errors |
| Database connection errors | Verify SUPABASE_SERVICE_ROLE_KEY is correct |

## FAQ

**Q: Can I deploy before configuring all env vars?**
A: Yes, deployment will complete but APIs won't work until env vars are added.

**Q: How do I use a custom domain?**
A: Add domain in Vercel Settings → Domains, then update DNS records at your registrar.

**Q: How do I rollback?**
A: Go to Deployments tab, click three dots on previous working deployment, select "Redeploy".

**Q: Is my SUPABASE_SERVICE_ROLE_KEY exposed?**
A: No - it's a server-side only environment variable and never sent to browser.

**Q: Can I use environment variables for preview deploys?**
A: Yes - configure "Preview" env vars separately in Vercel Settings.

## Next Steps

1. ✅ Create Vercel project
2. ✅ Add environment variables  
3. ✅ Test production deployment
4. ✅ Set up custom domain (optional)
5. ✅ Configure monitoring/alerts
6. ✅ Document prod credentials in secure location

## Production Checklist

- [ ] All env vars configured in Vercel
- [ ] First deployment successful
- [ ] Tested login/signup on production
- [ ] Tested admin dashboard on production
- [ ] Database operations working on production
- [ ] Error logs being captured
- [ ] Analytics enabled
- [ ] Custom domain configured (if applicable)
- [ ] Backup procedures documented
- [ ] Team members have Vercel access

---

**Need help?** 
- Vercel Docs: https://vercel.com/docs
- Supabase Docs: https://supabase.com/docs
