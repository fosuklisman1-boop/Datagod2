# Admin Settings - Join Community Link Configuration

## Overview

Admins can now configure a dynamic "Join Community" link that will be displayed throughout the application for users to join your community (Discord, WhatsApp, etc.).

## Features

✅ Admin-only settings page at `/admin/settings`  
✅ Dynamic join community link  
✅ URL validation  
✅ Real-time updates across the app  
✅ Displayed in sidebar for all users  
✅ Easy to manage and update  

## How to Use

### 1. Access Admin Settings

1. Log in as an admin
2. Go to `/admin` or click "Admin Panel" in sidebar
3. Click "Settings" in the sidebar (under ADMIN section)
4. You'll see the "App Settings" page

### 2. Configure Join Community Link

1. On the Settings page, find "Join Community Link"
2. Enter your community link (Discord, WhatsApp, etc.)
   - Example: `https://discord.gg/your-server-code`
   - Example: `https://chat.whatsapp.com/your-group-link`
3. Click "Save Settings"
4. You'll see a success message

### 3. View Preview

Before saving, you can see a preview of the link you entered. The link is clickable and opens in a new tab.

## Where the Link Appears

Once configured, the join community link will appear:

- **Sidebar**: Green "Join Community" button in the bottom left
- **Mobile**: Collapsible sidebar button
- **All Users**: All logged-in users will see it
- **Dynamic**: Updates automatically when you change it

## Database Setup

Before using this feature, run the SQL migration to create the `app_settings` table:

### In Supabase SQL Editor:

```sql
-- Create app_settings table
CREATE TABLE IF NOT EXISTS app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  join_community_link VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Anyone can view app settings" ON app_settings
  FOR SELECT
  USING (true);

CREATE POLICY "Service role can update settings" ON app_settings
  FOR UPDATE
  WITH CHECK (true);

CREATE POLICY "Service role can insert settings" ON app_settings
  FOR INSERT
  WITH CHECK (true);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_app_settings_id ON app_settings(id);

-- Grant permissions
GRANT SELECT ON app_settings TO anon, authenticated;
GRANT ALL ON app_settings TO service_role;
```

## Files Added

```
app/api/admin/settings/route.ts         API endpoint for settings
app/admin/settings/page.tsx             Admin settings page UI
hooks/use-app-settings.ts               Hook to fetch/use settings
components/join-community-button.tsx    Reusable component
components/layout/sidebar.tsx           (MODIFIED) To display button
migrations/create_app_settings_table.sql Database schema
```

## API Endpoints

### GET `/api/admin/settings`
Fetch current app settings (public endpoint)

**Response:**
```json
{
  "id": "uuid",
  "join_community_link": "https://discord.gg/...",
  "created_at": "2025-11-29T...",
  "updated_at": "2025-11-29T..."
}
```

### PUT `/api/admin/settings`
Update app settings (admin only)

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "join_community_link": "https://discord.gg/your-invite"
}
```

**Response:**
```json
{
  "success": true,
  "settings": {
    "id": "uuid",
    "join_community_link": "https://discord.gg/your-invite",
    "created_at": "2025-11-29T...",
    "updated_at": "2025-11-29T..."
  }
}
```

## How to Use the Hook

If you want to use the join community link in other components:

```typescript
import { useAppSettings } from "@/hooks/use-app-settings"

export function MyComponent() {
  const { joinCommunityLink, loading, error } = useAppSettings()

  if (loading) return <div>Loading...</div>
  if (error) return <div>Error: {error}</div>
  if (!joinCommunityLink) return null

  return (
    <a href={joinCommunityLink} target="_blank" rel="noopener noreferrer">
      Join Our Community
    </a>
  )
}
```

## Security

✅ Only admins can modify settings  
✅ JWT verification on API  
✅ URL validation (must be valid URL)  
✅ RLS policies protect data  
✅ Anon users can only read  

## Common Issues

### "User is not an admin"
- You must be logged in as an admin
- Check your admin status: Dashboard → Profile

### "Failed to save settings"
- Check browser console for error details
- Verify the URL format is correct
- Check that you're logged in

### Link doesn't update immediately
- The app caches settings for 60 seconds
- Refresh the page to see latest settings
- Or wait 1 minute for auto-refresh

### Can't see Settings option in sidebar
- You must be an admin
- Refresh the page after admin status is granted
- Check that you're logged in

## Testing

### Test 1: Set the Link
1. Go to `/admin/settings`
2. Enter any Discord or WhatsApp link
3. Click "Save Settings"
4. See success toast

### Test 2: Verify Sidebar Button
1. Refresh the page
2. Check sidebar for green "Join Community" button
3. Click it to verify it opens the correct link

### Test 3: Mobile Responsiveness
1. Open sidebar on mobile (tap menu icon)
2. Verify "Join Community" button appears
3. Test that it works when sidebar is collapsed

## Future Enhancements

Possible features to add:
- Additional community links (Facebook, Twitter, etc.)
- Banner/announcement system
- Link scheduling
- Analytics for link clicks
- Multiple community sections

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review browser console for errors
3. Check Supabase logs for API errors
4. Verify database table exists

