# Network Logos with Supabase Storage Buckets

## Setup Instructions

### Step 1: Create Storage Bucket in Supabase

1. Go to https://app.supabase.com
2. Select your Datagod2 project
3. Click on "Storage" in the left sidebar
4. Click "Create a new bucket"
5. Name it: `network-logos`
6. Make sure "Public bucket" is **enabled** (so logos are accessible)
7. Click "Create bucket"

### Step 2: Create Database Table

1. Go to "SQL Editor"
2. Click "New Query"
3. Copy content from `lib/network-logos-bucket-setup.sql`
4. **Important**: Replace `YOUR_PROJECT` with your actual Supabase project URL
   - Find it at: https://app.supabase.com/project/[project-id]/settings/api
   - Look for "Project URL" (e.g., `https://abcdef123.supabase.co`)
5. Click "Run"

### Step 3: Upload Logo Images

You have two options:

#### Option A: Upload via Supabase Dashboard
1. Go to "Storage" → "network-logos" bucket
2. Click "Upload" for each network
3. Upload images with these names:
   - `mtn.png` (or jpg)
   - `telecel.png`
   - `vodafone.png`
   - `at.png`
   - `airtel.png`
   - `ishare.png`

#### Option B: Upload Programmatically
The app now has a function to upload logos:

```typescript
import { networkLogoService } from "@/lib/shop-service"

// Upload a logo file
const file = new File([...], "mtn.png", { type: "image/png" })
await networkLogoService.uploadNetworkLogo("MTN", file)
```

### Step 4: Verify Setup

1. Go to Supabase Dashboard
2. Check "Storage" → "network-logos" has your images
3. Check "Table Editor" → "network_logos" has entries with correct URLs
4. Refresh your app at http://localhost:3000/shop/clings

## Features

✅ **Easy image management** - Upload images via dashboard or API
✅ **Real-time updates** - Change logos anytime
✅ **CDN-backed** - Fast image delivery via Supabase CDN
✅ **Easy to scale** - Add new networks by uploading new images
✅ **Automatic URLs** - App generates correct public URLs

## API Usage

```typescript
// Get all logos
const logos = await networkLogoService.getLogosAsObject()

// Get single logo URL
const mtnUrl = await networkLogoService.getNetworkLogo('MTN')

// Upload new logo
await networkLogoService.uploadNetworkLogo('MTN', file)

// Update logo URL directly
await networkLogoService.updateNetworkLogo('MTN', 'https://...')

// Get public URL for a file
const url = networkLogoService.getPublicLogoUrl('mtn.png')
```

## Troubleshooting

**Images not showing?**
1. Check bucket is set to "Public"
2. Verify URLs in database are correct
3. Check browser console for 404 errors

**Upload fails?**
1. Ensure bucket is public
2. Check file size is reasonable (< 5MB)
3. Verify file format is supported (PNG, JPG, GIF, WebP)

**Database errors?**
1. Make sure you replaced `YOUR_PROJECT` in the SQL script
2. Check project URL matches your actual Supabase URL
3. Verify table was created in Table Editor
