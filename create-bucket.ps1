# PowerShell script to create network-logos bucket in Supabase
# Usage: .\create-bucket.ps1 -SupabaseUrl "YOUR_URL" -ServiceRoleKey "YOUR_KEY"

param(
    [Parameter(Mandatory=$true)]
    [string]$SupabaseUrl,
    
    [Parameter(Mandatory=$true)]
    [string]$ServiceRoleKey
)

if (-not $SupabaseUrl -or -not $ServiceRoleKey) {
    Write-Host "Usage: .\create-bucket.ps1 -SupabaseUrl 'YOUR_URL' -ServiceRoleKey 'YOUR_KEY'"
    Write-Host ""
    Write-Host "Get these values from Supabase:"
    Write-Host "1. SupabaseUrl: Settings → API → Project URL"
    Write-Host "2. ServiceRoleKey: Settings → API → Service Role Key"
    exit 1
}

Write-Host "Creating network-logos bucket..." -ForegroundColor Cyan

$headers = @{
    "Authorization" = "Bearer $ServiceRoleKey"
    "Content-Type" = "application/json"
}

$body = @{
    name = "network-logos"
    public = $true
} | ConvertTo-Json

try {
    $response = Invoke-WebRequest -Uri "$SupabaseUrl/storage/v1/b" `
        -Method POST `
        -Headers $headers `
        -Body $body -ErrorAction Stop
    
    Write-Host "✅ Bucket created successfully!" -ForegroundColor Green
    Write-Host "Response: $($response.Content)" -ForegroundColor Gray
}
catch {
    $errorResponse = $_.Exception.Response.Content.ReadAsStream() | ForEach-Object { [char]$_ } | Join-String
    Write-Host "❌ Error: $errorResponse" -ForegroundColor Red
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Go to Supabase → Storage"
Write-Host "2. You should see 'network-logos' bucket"
Write-Host "3. Upload your logo images (mtn.png, telecel.png, etc.)"
