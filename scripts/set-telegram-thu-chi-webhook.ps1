# Bật webhook bot « Black Corp - Thu Chi »
# Nhận: Thu:/Chi: → THU_CHI; tin bot Báo cáo « TỔNG TIỀN CẦN THANH TOÁN » → CONG_NO
# Chạy SAU deploy. Bot Thu Chi phải có trong mọi nhóm đại lý (cùng nhóm với bot Báo cáo).
#
# $env:TELEGRAM_THU_CHI_BOT_TOKEN = "<token Black Corp - Thu Chi>"
# $env:WORKER_URL = "https://blackcorp-bot.<subdomain>.workers.dev"
# $env:TELEGRAM_WEBHOOK_SECRET = "<secret-tren-cloudflare>"
# .\scripts\set-telegram-thu-chi-webhook.ps1

param(
  [string]$BotToken = $env:TELEGRAM_THU_CHI_BOT_TOKEN,
  [string]$WorkerUrl = $env:WORKER_URL,
  [string]$WebhookSecret = $env:TELEGRAM_WEBHOOK_SECRET
)

if (-not $WebhookSecret) {
  $WebhookSecret = $env:TELEGRAM_SECRET
}

if (-not $BotToken) {
  Write-Host "Thieu token. Dat TELEGRAM_THU_CHI_BOT_TOKEN hoac -BotToken"
  exit 1
}

if (-not $WorkerUrl) {
  $WorkerUrl = Read-Host "URL Worker (vd https://blackcorp-bot.ten-ban.workers.dev)"
}
$WorkerUrl = $WorkerUrl.Trim().TrimEnd("/")
$WebhookUrl = "$WorkerUrl/api/telegram-thu-chi-webhook"

Write-Host "Thu Chi webhook: $WebhookUrl"

if (-not $WebhookSecret) {
  Write-Host "CANH BAO: Chua co TELEGRAM_WEBHOOK_SECRET tren Cloudflare."
}

$body = @{ url = $WebhookUrl }
if ($WebhookSecret) {
  $body.secret_token = $WebhookSecret
}

$json = $body | ConvertTo-Json -Compress
$res = Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/setWebhook" -Method Post -ContentType "application/json; charset=utf-8" -Body $json

if ($res.ok) {
  Write-Host "OK: $($res.description)"
  Invoke-RestMethod "https://api.telegram.org/bot$BotToken/getWebhookInfo" | Select-Object -ExpandProperty result | ConvertTo-Json -Depth 4
} else {
  Write-Host "Loi: $($res | ConvertTo-Json)"
  exit 1
}

try {
  $ping = Invoke-WebRequest -Uri $WebhookUrl -Method Get -UseBasicParsing
  Write-Host "GET -> $($ping.StatusCode) $($ping.Content)"
} catch {
  Write-Host "GET that bai: $_"
}

Write-Host ""
Write-Host "Buoc tiep:"
Write-Host "  1) Gỡ webhook bot Bao cao: .\scripts\remove-telegram-webhook.ps1"
Write-Host "  2) Them bot Thu Chi vao nhom dai ly (admin hoac tat Group Privacy @BotFather)"
Write-Host "  3) Test: gui Thu: 100 - AT (text hoac caption anh)"
