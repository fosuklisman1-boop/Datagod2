# Network Logos Database Setup

## How to set up network logos in the database:

1. **Go to Supabase Dashboard**
   - Open https://app.supabase.com
   - Navigate to your Datagod2 project

2. **Execute the SQL Migration**
   - Click on "SQL Editor" in the left sidebar
   - Click "New Query"
   - Copy the entire content from `lib/network-logos-migration.sql`
   - Paste it into the SQL editor
   - Click "Run" button

3. **Verify the Table Was Created**
   - Go to "Table Editor"
   - You should see a new table called `network_logos`
   - It should have 6 rows (one for each network: MTN, Telecel, Vodafone, AT, Airtel, iShare)

## Update Network Logos

To update a network logo in the future:

1. Go to Supabase SQL Editor
2. Run this query to update a network's logo:

```sql
UPDATE network_logos 
SET logo_data = 'data:image/svg+xml;base64,YOUR_NEW_BASE64_DATA'
WHERE network_name = 'MTN';
```

Replace:
- `YOUR_NEW_BASE64_DATA` with your new base64-encoded image
- `'MTN'` with the network name you want to update

## Network Logo API

The app now fetches logos from the database. The service layer provides:

```typescript
// Get all network logos as an object
const logos = await networkLogoService.getLogosAsObject()

// Get a single network's logo
const mtnLogo = await networkLogoService.getNetworkLogo('MTN')

// Update a network logo
await networkLogoService.updateNetworkLogo('MTN', 'data:image/svg+xml;base64,...')
```

The storefront automatically fetches and caches all network logos when it loads.
