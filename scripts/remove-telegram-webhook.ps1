# Gỡ webhook bot Báo cáo (bot này chỉ gửi tin chi phí / TỔNG TIỀN, không nhận webhook Worker)
#
# $env:TELEGRAM_BOT_TOKEN = "<token Black Corp - Bao cao>"
# .\scripts\remove-telegram-webhook.ps1

param([string]$BotToken = $env:TELEGRAM_BOT_TOKEN)

if (-not $BotToken) {
  Write-Host "Thieu token. Dat TELEGRAM_BOT_TOKEN hoac -BotToken"
  exit 1
}

$res = Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/deleteWebhook?drop_pending_updates=true" -Method Get
if ($res.ok) {
  Write-Host "OK: Da go webhook bot Bao cao."
  Invoke-RestMethod "https://api.telegram.org/bot$BotToken/getWebhookInfo" | Select-Object -ExpandProperty result | ConvertTo-Json -Depth 4
} else {
  Write-Host "Loi: $($res | ConvertTo-Json)"
  exit 1
}
