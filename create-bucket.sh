#!/bin/bash
# This script creates the network-logos storage bucket in Supabase
# Usage: bash create-bucket.sh YOUR_SUPABASE_URL YOUR_SERVICE_KEY

SUPABASE_URL=$1
SERVICE_ROLE_KEY=$2

if [ -z "$SUPABASE_URL" ] || [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "Usage: bash create-bucket.sh <SUPABASE_URL> <SERVICE_ROLE_KEY>"
  echo ""
  echo "Get these values from:"
  echo "1. SUPABASE_URL: Settings → API → Project URL"
  echo "2. SERVICE_ROLE_KEY: Settings → API → Service Role Key"
  exit 1
fi

echo "Creating network-logos bucket..."

curl -X POST \
  "$SUPABASE_URL/storage/v1/b" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "network-logos",
    "public": true
  }'

echo ""
echo "✅ Bucket created! You can now upload logo images."
