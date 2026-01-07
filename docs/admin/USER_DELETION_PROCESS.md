# User Deletion & Data Cleanup

## Overview
When an admin removes a user from the system, a comprehensive data cleanup process is initiated to ensure data integrity and compliance with data protection regulations.

## Data Deletion Process

When a user is removed via the admin panel, the following data is deleted in order:

### 1. **Notifications** ✅
- All unread and read notifications sent to the user
- Deletion cascades through the notifications table

### 2. **Complaints** ✅
- All complaint tickets filed by the user
- Includes complaint descriptions, resolution notes, and attachments
- Status: Deleted permanently

### 3. **Transactions** ✅
- All transaction history (wallet top-ups, purchases, refunds)
- Financial records including amounts, balances, and descriptions
- Cannot be recovered once deleted

### 4. **Withdrawal Requests** ✅
- All pending and completed withdrawal requests
- Bank/mobile money account details associated with withdrawals
- Transaction codes and reference numbers

### 5. **Orders** ✅
- All data purchase orders (packages, networks, sizes)
- Order codes, phone numbers, and transaction details
- Order history and delivery status

### 6. **AFA (MTN Affiliate) Orders** ✅
- All AFA registration submissions
- Agent names, phone numbers, and application status
- Order and transaction codes for AFA registrations

### 7. **Shops & Shop Orders** ✅
- All user shops (store fronts)
- All orders placed through user shops
- Shop settings and configurations
- Shop analytics and transaction history

### 8. **Wallet** ✅
- User's wallet account
- Balance, credited amount, and spent amount records
- Wallet transaction history is handled separately

### 9. **User Profile** ✅
- Main user record
- Email, name, phone number
- Role and account status
- Profile metadata

### 10. **Authentication Account** ✅
- User's auth account in Supabase Authentication
- Login credentials and session tokens
- Email verification status
- Password reset tokens

## API Response

The endpoint returns detailed information about what was deleted:

```json
{
  "success": true,
  "message": "User and all associated data deleted successfully",
  "deleted": {
    "auth": true,
    "profile": true,
    "wallet": true,
    "orders": true,
    "afaorders": true,
    "transactions": true,
    "withdrawals": true,
    "complaints": true,
    "notifications": true,
    "shops": 2
  }
}
```

## Deletion Strategy

### Cascading Deletes
- Database foreign keys are configured with `ON DELETE CASCADE`
- This ensures automatic cleanup of dependent records
- Provides data integrity at the database level

### Explicit Deletion
- The API explicitly deletes each table for:
  - Better error handling and logging
  - Audit trail of what was deleted
  - Clear visibility into deletion process
  - Graceful handling if some tables fail

### Error Handling
- If one table fails to delete, the process continues
- Warnings are logged but don't prevent user auth deletion
- Final operation: Delete user from Supabase Auth (critical)

## Audit Logging

Every user deletion is logged with:
- Admin ID who performed the deletion
- User ID being deleted
- Timestamp of deletion
- Number of records deleted from each table

Example log:
```
[REMOVE-USER] Admin 123e4567-e89b-12d3-a456-426614174000 removing user 987f4321-f89b-12d3-a456-426614174999
[REMOVE-USER] User 987f4321-f89b-12d3-a456-426614174999 successfully removed
```

## Data Permanence

⚠️ **WARNING**: User deletion is **PERMANENT AND IRREVERSIBLE**

- No data is archived or backed up
- No recovery option is available
- All financial records are permanently deleted
- All transaction history is lost

## GDPR Compliance

This deletion process supports GDPR "Right to be Forgotten" requests:
- ✅ Removes personally identifiable information (PII)
- ✅ Deletes authentication credentials
- ✅ Removes transaction history
- ✅ Eliminates user's digital footprint

## Best Practices

### Before Deleting a User:
1. ✅ Verify the user actually wants their account deleted
2. ✅ Export/backup any important user data if needed
3. ✅ Resolve any pending withdrawal requests or payment issues
4. ✅ Close any open complaint tickets with resolution notes
5. ✅ Notify user email of impending deletion (recommended)

### After Deleting a User:
1. ✅ Verify deletion was successful
2. ✅ Check audit logs
3. ✅ Monitor for any referential integrity issues
4. ✅ Update user count/analytics

## Troubleshooting

### If Deletion Fails
- Check server logs for errors
- Verify admin has correct permissions
- Ensure no foreign key constraints are preventing deletion
- Attempt deletion again or contact support

### If Some Tables Fail
- Some data may remain in the system
- Check the API response for which tables failed
- Manually delete remaining data if necessary
- Contact database administrator

## See Also
- [Admin User Management](/app/admin/users/page.tsx)
- [Authentication Setup](/lib/supabase.ts)
- [Database Schema](/SUPABASE_SETUP.md)
