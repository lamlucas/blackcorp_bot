# Đăng ký webhook Telegram → Worker blackcorp-bot (phản hồi tức thì)
# Chạy SAU KHI deploy và đã thêm Secret TELEGRAM_WEBHOOK_SECRET (hoặc TELEGRAM_SECRET) trên Cloudflare.
#
# $env:TELEGRAM_BOT_TOKEN = "<token Black Corp - Thu Chi>"
# $env:WORKER_URL = "https://blackcorp-bot.<subdomain-cua-ban>.workers.dev"
# $env:TELEGRAM_WEBHOOK_SECRET = "chuoi-trung-secret-tren-cf"
# .\scripts\set-telegram-webhook.ps1

param(
  [string]$BotToken = $env:TELEGRAM_BOT_TOKEN,
  [string]$WorkerUrl = $env:WORKER_URL,
  [string]$WebhookSecret = $env:TELEGRAM_WEBHOOK_SECRET
)

if (-not $WebhookSecret) {
  $WebhookSecret = $env:TELEGRAM_SECRET
}

if (-not $BotToken) {
  Write-Host "Thieu token. Dat TELEGRAM_BOT_TOKEN hoac -BotToken"
  exit 1
}

if (-not $WorkerUrl) {
  $WorkerUrl = Read-Host "URL Worker (vd https://blackcorp-bot.ten-ban.workers.dev)"
}
$WorkerUrl = $WorkerUrl.Trim().TrimEnd("/")
$WebhookUrl = "$WorkerUrl/api/telegram-webhook"

Write-Host "Webhook URL: $WebhookUrl"

if (-not $WebhookSecret) {
  Write-Host "CANH BAO: Chua co TELEGRAM_WEBHOOK_SECRET — Telegram se khong gui secret header."
  Write-Host "Them Secret tren Cloudflare (Encrypt) roi chay lai script."
}

$body = @{ url = $WebhookUrl }
if ($WebhookSecret) {
  $body.secret_token = $WebhookSecret
  Write-Host "secret_token: (da dat, phai trung Secret tren CF)"
}

$json = $body | ConvertTo-Json -Compress
$res = Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/setWebhook" -Method Post -ContentType "application/json; charset=utf-8" -Body $json

if ($res.ok) {
  Write-Host "OK: $($res.description)"
  $info = Invoke-RestMethod "https://api.telegram.org/bot$BotToken/getWebhookInfo"
  $info.result | ConvertTo-Json -Depth 4
} else {
  Write-Host "Loi: $($res | ConvertTo-Json)"
  exit 1
}

try {
  $ping = Invoke-WebRequest -Uri $WebhookUrl -Method Get -UseBasicParsing
  Write-Host "GET -> $($ping.StatusCode) $($ping.Content)"
} catch {
  Write-Host "GET that bai (kiem tra deploy + URL Worker): $_"
}

Write-Host ""
Write-Host "Tren Cloudflare Worker blackcorp-bot:"
Write-Host "  - TELEGRAM_POLL_ENABLED = 0 (tat cron getUpdates 2 phut)"
Write-Host "  - Xoa trigger cron */2 * * * * neu con trong Dashboard (chi giu 0 15 * * *)"
