# Shop Settings - WhatsApp Link Configuration

## Overview

Shop Settings allows shop owners to configure their WhatsApp contact link, which appears across their storefront and helps customers reach out for support or inquiries.

**Status**: ✅ Fully Implemented

## What's Included

### 1. Database Schema
- **Table**: `shop_settings`
- **Location**: `migrations/create_shop_settings_table.sql`
- **Features**:
  - Stores WhatsApp link and other shop-specific settings
  - RLS policies for security (public read, owner-only write)
  - Indexes on `shop_id` and `updated_at` for performance

### 2. API Endpoint
- **Location**: `app/api/shop/settings/[shopId]/route.ts`
- **Methods**:
  - `GET` - Retrieve shop settings (public access, no authentication required)
  - `PUT` - Update shop settings (requires JWT token + shop ownership verification)
- **Features**:
  - URL validation for WhatsApp links
  - Shop ownership verification
  - Error handling with descriptive messages

### 3. Settings UI Page
- **Location**: `app/dashboard/my-shop/settings/page.tsx`
- **Features**:
  - Form to input WhatsApp link
  - URL validation and preview
  - Help text with instructions on how to get WhatsApp link
  - Save functionality with error handling
  - Loading states and feedback

### 4. React Hook
- **Location**: `hooks/use-shop-settings.ts`
- **Usage**: Fetch shop settings from the API
- **Features**:
  - Loading state
  - Error handling
  - Type-safe settings object

### 5. WhatsApp Button Component
- **Location**: `components/whatsapp-button.tsx`
- **Features**:
  - Two variants: "default" (with text) and "compact" (icon only)
  - Conditional rendering (hidden if no link)
  - Accessible with proper labels
  - Responsive styling

### 6. Restructured Storefront
- **Location**: `app/shop/[slug]/page.tsx`
- **Layout**: Sidebar + Main content
- **Features**:
  - Three main tabs: Products, About, Contact
  - Sidebar navigation with sticky positioning
  - Shop information card in sidebar
  - WhatsApp link displayed prominently
  - Order tracking integrated in Contact tab

## File Structure

```
app/
├── api/shop/settings/
│   └── [shopId]/route.ts          # API endpoint for CRUD
├── dashboard/my-shop/
│   └── settings/page.tsx          # Settings UI page
└── shop/[slug]/
    └── page.tsx                   # Restructured storefront

components/
├── whatsapp-button.tsx            # Reusable WhatsApp button
└── layout/
    └── sidebar.tsx                # Main app sidebar (integrated join link)

hooks/
├── use-shop-settings.ts           # Hook for fetching settings
└── use-app-settings.ts            # Hook for admin settings

migrations/
├── create_shop_settings_table.sql  # Database schema
└── create_app_settings_table.sql   # Admin settings schema
```

## Implementation Details

### API Endpoint - GET /api/shop/settings/[shopId]

**Response** (200 OK):
```json
{
  "id": "uuid",
  "shop_id": "uuid",
  "whatsapp_link": "https://wa.me/1234567890",
  "created_at": "2025-01-01T00:00:00Z",
  "updated_at": "2025-01-01T00:00:00Z"
}
```

**Response** (404 Not Found):
```json
{
  "whatsapp_link": null
}
```

### API Endpoint - PUT /api/shop/settings/[shopId]

**Request**:
```json
{
  "whatsapp_link": "https://wa.me/1234567890"
}
```

**Authentication**: Bearer token (JWT from Supabase)

**Validation**:
- Valid URL format required
- Shop ownership must be verified
- User must have valid JWT token

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "shop_id": "uuid",
    "whatsapp_link": "https://wa.me/1234567890",
    "updated_at": "2025-01-01T00:00:00Z"
  }
}
```

**Errors**:
- 400: Invalid URL format
- 401: Unauthorized (missing/invalid JWT)
- 403: Forbidden (not shop owner)
- 500: Server error

## How to Use

### For Shop Owners

#### 1. Access Shop Settings
Navigate to: `Dashboard → My Shop → Settings`

#### 2. Configure WhatsApp Link
- Enter your WhatsApp link (format: `https://wa.me/YOUR_NUMBER`)
- Use country code in phone number (e.g., +233 for Ghana)
- Example: `https://wa.me/233501234567`

#### 3. Save
Click "Save Settings" button to apply changes

#### 4. View on Storefront
The WhatsApp link will appear:
- **On Shop Header**: "Contact on WhatsApp" button
- **In Sidebar**: Shop information card
- **In Contact Tab**: Full contact options section

### For Developers

#### 1. Use the Hook
```typescript
import { useShopSettings } from "@/hooks/use-shop-settings"

function MyComponent({ shopId }: { shopId: string }) {
  const { settings, loading, error } = useShopSettings(shopId)

  if (loading) return <div>Loading...</div>
  if (error) return <div>Error: {error}</div>

  return (
    <a href={settings?.whatsapp_link} target="_blank">
      Contact on WhatsApp
    </a>
  )
}
```

#### 2. Use the WhatsApp Button Component
```typescript
import { WhatsAppButton } from "@/components/whatsapp-button"

export function MyStorefront() {
  const whatsappLink = "https://wa.me/233501234567"

  return (
    <div>
      {/* Full button with text */}
      <WhatsAppButton whatsappLink={whatsappLink} />

      {/* Compact circular button */}
      <WhatsAppButton
        whatsappLink={whatsappLink}
        variant="compact"
        className="fixed bottom-4 right-4"
      />
    </div>
  )
}
```

#### 3. Fetch Settings Directly from API
```typescript
const response = await fetch(`/api/shop/settings/${shopId}`)
const settings = await response.json()

if (settings.whatsapp_link) {
  console.log("WhatsApp link:", settings.whatsapp_link)
}
```

## Database Schema

### shop_settings Table

```sql
CREATE TABLE shop_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  whatsapp_link TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(shop_id)
);

-- Indexes
CREATE INDEX idx_shop_settings_shop_id ON shop_settings(shop_id);
CREATE INDEX idx_shop_settings_updated_at ON shop_settings(updated_at);

-- RLS Policies
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;

-- Public read access
CREATE POLICY "Public can read shop settings"
  ON shop_settings FOR SELECT
  USING (true);

-- Shop owner can insert
CREATE POLICY "Shop owner can insert settings"
  ON shop_settings FOR INSERT
  WITH CHECK (
    shop_id IN (
      SELECT id FROM shops WHERE user_id = auth.uid()
    )
  );

-- Shop owner can update
CREATE POLICY "Shop owner can update settings"
  ON shop_settings FOR UPDATE
  USING (
    shop_id IN (
      SELECT id FROM shops WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    shop_id IN (
      SELECT id FROM shops WHERE user_id = auth.uid()
    )
  );

-- Shop owner can delete
CREATE POLICY "Shop owner can delete settings"
  ON shop_settings FOR DELETE
  USING (
    shop_id IN (
      SELECT id FROM shops WHERE user_id = auth.uid()
    )
  );
```

## Security Considerations

### 1. Authentication
- PUT/DELETE operations require valid JWT token
- Token verified via `/api/auth/session`

### 2. Authorization
- Shop ownership verified by checking `shops.user_id` matches authenticated user
- Users can only modify their own shop settings

### 3. Input Validation
- WhatsApp link must be valid URL format
- URL validation performed on both client and server

### 4. RLS Policies
- Database-level security with Row Level Security
- Public can read settings (storefront display)
- Only owner can modify settings

## Integration Points

### With Storefront
- WhatsApp link automatically displayed in header
- Link appears in sidebar info card
- Full contact section in Contact tab

### With Admin Settings
- Similar structure to admin settings feature
- Uses same JWT verification pattern
- Same database migration approach

### With Notifications
- Settings can be extended for notification preferences
- WhatsApp link can be used for WhatsApp notifications (future)

## Testing

### Manual Testing

1. **Settings Page**
   - Navigate to dashboard → my-shop → settings
   - Enter WhatsApp link
   - Click Save
   - Verify success message

2. **Storefront Display**
   - Visit storefront at `/shop/[slug]`
   - Check for WhatsApp button in header
   - Check sidebar information
   - Check Contact tab

3. **API Testing**
   ```bash
   # Get settings
   curl http://localhost:3000/api/shop/settings/[shopId]

   # Update settings (with token)
   curl -X PUT http://localhost:3000/api/shop/settings/[shopId] \
     -H "Authorization: Bearer [TOKEN]" \
     -H "Content-Type: application/json" \
     -d '{"whatsapp_link": "https://wa.me/233501234567"}'
   ```

## Troubleshooting

### Issue: "WhatsApp link not saving"
**Solution**: 
- Ensure URL is valid (starts with https://)
- Check browser console for errors
- Verify JWT token is valid

### Issue: "Shop not found" on settings page
**Solution**:
- Ensure user owns the shop
- Check shop ID in URL
- Verify shop exists in database

### Issue: "WhatsApp button not showing on storefront"
**Solution**:
- Verify settings were saved
- Check API endpoint returns correct data
- Verify hook is properly loading settings

### Issue: "Link not clickable"
**Solution**:
- Ensure URL is properly formatted
- Check for JavaScript errors in console
- Verify mobile/browser WhatsApp support

## Performance Optimization

### Caching
- Settings hook includes basic loading/error states
- Consider implementing SWR or React Query for better caching

### Database Queries
- `shop_id` index ensures fast lookups
- `updated_at` index for sorting/filtering
- Unique constraint on `shop_id` prevents duplicates

### API Response
- Settings endpoint returns quickly even if not configured
- No N+1 queries (single shop lookup)

## Future Enhancements

### Possible Additions
1. **Multiple Contact Methods**
   - Facebook Messenger
   - Email
   - Phone number (with click-to-call)

2. **Custom Messages**
   - Pre-filled message template
   - Greeting text for storefront

3. **Analytics**
   - Track WhatsApp link clicks
   - Conversion metrics

4. **Notification Settings**
   - Allow owner to configure notification preferences
   - WhatsApp notifications for orders

5. **Team Members**
   - Allow multiple WhatsApp links
   - Route messages to different team members

## Related Documentation

- See `ADMIN_SETTINGS_GUIDE.md` for admin settings implementation
- See `GETTING_STARTED_NOTIFICATIONS.md` for notification system
- See `NOTIFICATION_INTEGRATION_GUIDE.md` for integration patterns

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review API endpoint responses
3. Check browser console for errors
4. Verify database migrations have run
5. Check user permissions and shop ownership
