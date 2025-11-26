# Creating Network Logos Storage Bucket

## Option 1: Manual Creation (Easy)

1. Go to https://app.supabase.com
2. Select your Datagod2 project
3. Click **Storage** in the left sidebar
4. Click **Create a new bucket**
5. Name: `network-logos`
6. Enable **Public bucket** toggle
7. Click **Create bucket**

That's it! ✅

---

## Option 2: SQL Creation

1. Go to **SQL Editor** in Supabase
2. Click **New Query**
3. Copy content from `lib/create-storage-bucket.sql`
4. Click **Run**

---

## Option 3: PowerShell Script (Windows)

1. Get your Supabase credentials:
   - Go to https://app.supabase.com/project/YOUR_PROJECT/settings/api
   - Copy **Project URL** (e.g., `https://abcdef.supabase.co`)
   - Copy **Service Role Key** (under "Project API keys")

2. Run the PowerShell script:
```powershell
cd c:\DATAGOD2\Datagod2
.\create-bucket.ps1 -SupabaseUrl "https://YOUR_PROJECT.supabase.co" -ServiceRoleKey "YOUR_SERVICE_ROLE_KEY"
```

3. The script will create the bucket automatically

---

## Option 4: Bash Script (Mac/Linux)

```bash
cd /path/to/datagod2
bash create-bucket.sh "https://YOUR_PROJECT.supabase.co" "YOUR_SERVICE_ROLE_KEY"
```

---

## After Creating the Bucket

1. Go to **Storage** → **network-logos**
2. Click **Upload**
3. Upload your logo files with these exact names:
   - `mtn.png`
   - `telecel.png`
   - `vodafone.png`
   - `at.png`
   - `airtel.png`
   - `ishare.png`

4. Verify the database URLs are correct:
   - Go to **Table Editor** → **network_logos**
   - Check that logo_url values match your actual Supabase URL

5. Test the storefront at http://localhost:3000/shop/clings
   - Network cards should now display logos! ✅

---

## Troubleshooting

**Can't see bucket?**
- Refresh the Storage page
- Make sure you're in the right project

**Images not showing?**
- Verify bucket is set to "Public"
- Check file names match exactly (case-sensitive on Linux)
- Check URLs in database are correct

**Upload fails?**
- Make sure bucket is public
- File size should be < 5MB
- Use PNG, JPG, GIF, or WebP format
