param(
  [Parameter(Mandatory = $false)]
  [string]$Url = "https://cdn.jsdelivr.net/gh/lamlucas/blackcorp_bot@main/qr1.jpg",

  [Parameter(Mandatory = $false)]
  [switch]$Deploy
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) {
  throw "Không tìm thấy 'wrangler'. Cài bằng: npm i -g wrangler"
}

Write-Host "Set PAYMENT_IMAGE_URL_1 secret => $Url"
$Url | wrangler secret put PAYMENT_IMAGE_URL_1

if ($Deploy) {
  Write-Host "Deploy worker..."
  wrangler deploy
} else {
  Write-Host "Đã set secret. Chạy 'wrangler deploy' để áp dụng nếu cần."
}

