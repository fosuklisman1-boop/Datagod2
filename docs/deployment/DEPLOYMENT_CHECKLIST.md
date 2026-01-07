# Deployment Checklist - Order-Specific Complaint System

## ✅ Pre-Deployment Status

### Code Status
- [x] Frontend components complete
- [x] Backend API endpoint created
- [x] TypeScript compilation successful
- [x] Build passes without errors
- [x] All bug fixes applied
- [x] Code properly formatted
- [x] Error handling implemented
- [x] Loading states added
- [x] Validation implemented (client & server)

### Documentation Status
- [x] COMPLAINTS_SETUP.md - Setup instructions
- [x] COMPLAINTS_IMPLEMENTATION.md - Implementation details
- [x] FINAL_SUMMARY.md - Complete summary
- [x] QUICK_REFERENCE.md - Quick reference
- [x] ARCHITECTURE_DIAGRAMS.md - Visual diagrams
- [x] This checklist - Deployment guide

### Testing Status
- [ ] Component renders without errors
- [ ] Modal opens on button click
- [ ] Form validation works
- [ ] Image upload works
- [ ] API receives FormData correctly
- [ ] Images upload to Supabase Storage
- [ ] Complaint record created in database
- [ ] Admin can view complaints
- [ ] Images display in admin dashboard

---

## 🚀 Deployment Steps

### Step 1: Database Setup (REQUIRED)

**Estimated Time**: 5-10 minutes

1. [ ] Connect to Supabase PostgreSQL console
2. [ ] Copy SQL from `COMPLAINTS_SETUP.md` section "SQL Migration"
3. [ ] Execute migration to add columns:
   - [ ] `order_id` (UUID FK)
   - [ ] `evidence` (JSONB)
   - [ ] `order_details` (JSONB)
4. [ ] Execute index creation:
   - [ ] `idx_complaints_order_id`
   - [ ] `idx_complaints_user_id`
   - [ ] `idx_complaints_status`
5. [ ] Verify schema changes:
   - [ ] Run: `SELECT * FROM complaints LIMIT 1;`
   - [ ] Confirm new columns appear

**Validation SQL**:
```sql
-- Check schema
\d complaints

-- Or query:
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'complaints'
ORDER BY ordinal_position;
```

### Step 2: Storage Bucket Setup (REQUIRED)

**Estimated Time**: 5-10 minutes

1. [ ] Log into Supabase Dashboard
2. [ ] Navigate to Storage section
3. [ ] Click "New Bucket"
4. [ ] Configure bucket:
   - [ ] Name: `complaint-evidence`
   - [ ] Privacy: **Private** (NOT public)
   - [ ] File size limit: 10 MB
5. [ ] Click Create Bucket
6. [ ] In bucket policies, add RLS rules:
   - [ ] Users can upload to their own folder
   - [ ] Users can view their own evidence
   - [ ] Admins can view all evidence

**Sample Policy SQL** (from COMPLAINTS_SETUP.md):
```sql
CREATE POLICY "Users can upload their evidence" 
  ON storage.objects 
  FOR INSERT 
  WITH CHECK (bucket_id = 'complaint-evidence' 
    AND auth.uid()::text = (storage.foldername(name))[1]);
```

### Step 3: Environment Variables (VERIFY)

**Estimated Time**: 2-3 minutes

1. [ ] Check `.env.local` file contains:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
   ```
2. [ ] All keys are correct (copy-paste from Supabase)
3. [ ] No typos in variable names
4. [ ] Restart dev server if keys were changed

### Step 4: Restart Development Server

**Estimated Time**: 1 minute

```bash
# Stop current server (Ctrl+C)
# Restart with:
npm run dev

# Or use:
npm run build  # Test production build
```

### Step 5: Feature Testing

**Estimated Time**: 10-15 minutes

#### Test 5.1: Basic Complaint Filing
- [ ] Navigate to `/dashboard/my-orders`
- [ ] Locate an order
- [ ] Click "Complain" button (should open modal)
- [ ] Modal displays order details correctly
- [ ] Verify shown: Network, Package, Phone, Amount, Date

#### Test 5.2: Form Validation
- [ ] Clear description field and try submit → Should show error
- [ ] Enter description < 10 chars and try submit → Should show error
- [ ] Skip image upload and try submit → Should show error for each image
- [ ] Fill valid description and try submit without images → Should error

#### Test 5.3: Image Upload
- [ ] Try uploading PDF file → Should reject (wrong type)
- [ ] Try uploading 10MB JPG file → Should reject (too large)
- [ ] Upload valid JPG file (< 5MB) → Should show preview
- [ ] Change image by clicking "Change Image" button → Should clear and allow new upload
- [ ] Upload both images → Both should show checkmarks

#### Test 5.4: Successful Submission
- [ ] Fill all fields correctly:
  - [ ] Description: "Test complaint message for order" (> 10 chars)
  - [ ] Priority: Select one option
  - [ ] Balance Image: Upload valid image
  - [ ] Receipt Image: Upload valid image
- [ ] Click Submit button
- [ ] Should show loading state
- [ ] Should show success toast message
- [ ] Modal should close
- [ ] Form should reset

#### Test 5.5: Database Verification
- [ ] In Supabase console, query:
  ```sql
  SELECT id, user_id, order_id, description, priority, status 
  FROM complaints 
  WHERE created_at > NOW() - INTERVAL '1 minute'
  ORDER BY created_at DESC 
  LIMIT 5;
  ```
- [ ] Should see newly created complaint
- [ ] Verify `order_id` is populated
- [ ] Verify `status` is 'pending'

#### Test 5.6: Storage Verification
- [ ] In Supabase Storage, navigate to `complaint-evidence` bucket
- [ ] Should see folders with user IDs
- [ ] Inside each user folder, should see order IDs
- [ ] Inside each order folder, should see:
  - [ ] `balance-{timestamp}.jpg`
  - [ ] `receipt-{timestamp}.jpg`

#### Test 5.7: Admin Dashboard
- [ ] Navigate to `/admin/complaints`
- [ ] Should see new complaint in list
- [ ] Click to view details
- [ ] Should display:
  - [ ] Complaint description
  - [ ] Priority level
  - [ ] Order details
  - [ ] (Optional: Evidence images)
- [ ] Try changing status to "In-Progress"
- [ ] Try adding resolution notes
- [ ] Save changes
- [ ] Verify status updated in database

### Step 6: Performance Testing (Optional)

**Estimated Time**: 5 minutes

- [ ] Test with image upload progress (note speed)
- [ ] Check storage bucket for file organization
- [ ] Query database for any slow queries
- [ ] Monitor browser DevTools network tab during submission
- [ ] Check for console errors or warnings

### Step 7: Error Scenario Testing (Optional)

**Estimated Time**: 5-10 minutes

- [ ] Test with internet disconnection (simulate)
- [ ] Test with invalid image (corrupted file)
- [ ] Test with very large image (> 100MB)
- [ ] Test rapid form submissions (spam click)
- [ ] Test with special characters in description
- [ ] Test with very long description (> 5000 chars)

### Step 8: Security Testing (Optional)

**Estimated Time**: 5 minutes

- [ ] Verify unauthenticated users cannot access modal
- [ ] Verify users cannot submit with someone else's userId
- [ ] Verify file type validation on both client and server
- [ ] Verify users cannot access other users' complaint images
- [ ] Verify admin can access all complaints

### Step 9: Cross-Browser Testing (Optional)

**Estimated Time**: 10 minutes

Test on:
- [ ] Chrome/Edge (Chromium)
- [ ] Firefox
- [ ] Safari
- [ ] Mobile browsers (iPhone Safari, Android Chrome)

Check:
- [ ] Modal displays correctly
- [ ] Image upload works
- [ ] Form validation shows correctly
- [ ] Toast notifications appear
- [ ] Modal closes on mobile

### Step 10: Deployment

**Estimated Time**: 5-10 minutes

1. [ ] All tests passed
2. [ ] Code is built and ready
3. [ ] Environment variables set
4. [ ] Database schema updated
5. [ ] Storage bucket created
6. [ ] Deploy to production:
   ```bash
   npm run build  # Test build
   # If successful:
   git push origin main  # Or deploy via your deployment service
   ```

---

## 📋 Production Checklist

Before going live:

- [ ] Database backups created
- [ ] Error logging configured
- [ ] Monitoring/alerting set up
- [ ] Email notifications configured (if applicable)
- [ ] User documentation prepared
- [ ] Admin documentation prepared
- [ ] Support team trained
- [ ] Rollback plan documented
- [ ] Performance baselines established

---

## 🆘 Troubleshooting

### Issue: "Failed to upload images"
- [ ] Check Supabase storage bucket exists: `complaint-evidence`
- [ ] Check bucket privacy setting: should be "Private"
- [ ] Check service role key is valid
- [ ] Check browser console for CORS errors
- [ ] Check Supabase logs for storage errors

### Issue: "Complaint not saving to database"
- [ ] Check database schema includes `order_id` column
- [ ] Check user authentication is working
- [ ] Check Supabase logs for SQL errors
- [ ] Verify RLS policies aren't blocking insert
- [ ] Try inserting test record via SQL

### Issue: "Modal not opening"
- [ ] Check "Complain" button is rendering
- [ ] Check browser console for JavaScript errors
- [ ] Verify useAuth hook returns user object
- [ ] Check complaintModalOpen state changes

### Issue: "Images not displaying in admin"
- [ ] Check storage URLs are public/signed correctly
- [ ] Check admin has storage read permissions
- [ ] Verify image files exist in storage
- [ ] Check CORS settings in Supabase
- [ ] Try direct URL in browser

### Issue: "Validation errors not showing"
- [ ] Check toast notifications are enabled
- [ ] Check browser console for errors
- [ ] Verify validation logic in component
- [ ] Check form submission handler

---

## 📊 Post-Deployment Monitoring

### Daily Checks
- [ ] Monitor error logs for API failures
- [ ] Check storage usage growth
- [ ] Monitor database query performance
- [ ] Review complaint submission metrics

### Weekly Checks
- [ ] Review complaint trends
- [ ] Check resolution time metrics
- [ ] Monitor user feedback
- [ ] Check for storage cleanup needs

### Monthly Checks
- [ ] Database optimization
- [ ] Storage bucket analysis
- [ ] Performance review
- [ ] Feature improvement planning

---

## 📞 Support Resources

If you encounter issues:

1. **Check Documentation**:
   - COMPLAINTS_SETUP.md - Setup guide
   - COMPLAINTS_IMPLEMENTATION.md - Technical details
   - QUICK_REFERENCE.md - Quick answers

2. **Check Supabase Docs**:
   - Storage: https://supabase.com/docs/guides/storage
   - Database: https://supabase.com/docs/guides/database
   - Auth: https://supabase.com/docs/guides/auth

3. **Check Logs**:
   - Supabase dashboard logs
   - Browser console (F12)
   - Server logs (if available)

---

## ✨ Success Criteria

Deployment is successful when:

✅ Customers can file complaints on orders  
✅ Complaints linked to specific orders  
✅ Evidence images upload correctly  
✅ Admin can view complaints and images  
✅ Form validation prevents errors  
✅ Error handling graceful  
✅ No errors in browser console  
✅ No errors in server logs  
✅ Database schema correct  
✅ Storage bucket working  

---

## 🎉 What's Next?

After successful deployment:

1. **Phase 2: Enhancements**
   - Email notifications
   - SMS alerts
   - Auto-resolution workflows
   - Complaint analytics dashboard

2. **Phase 3: Optimization**
   - Image compression
   - Thumbnail generation
   - Caching strategies
   - Performance tuning

3. **Phase 4: Integration**
   - Refund automation
   - Customer support chat
   - Status tracking emails
   - Mobile app integration

---

**Ready to deploy?**

Follow the steps above in order. Most issues can be resolved by checking the documentation and logs. Good luck! 🚀
