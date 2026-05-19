# Cau hinh dung 2 bot: Thu Chi nhan webhook, Bao cao chi gui tin
#
# $env:TELEGRAM_BOT_TOKEN = "<token Black Corp - Bao cao>"
# $env:TELEGRAM_THU_CHI_BOT_TOKEN = "<token Black Corp - Thu Chi>"
# $env:WORKER_URL = "https://blackcorp-bot.<subdomain>.workers.dev"
# $env:TELEGRAM_WEBHOOK_SECRET = "<secret-cloudflare>"
# .\scripts\setup-telegram-bots.ps1

param(
  [string]$BaocaoToken = $env:TELEGRAM_BOT_TOKEN,
  [string]$ThuChiToken = $env:TELEGRAM_THU_CHI_BOT_TOKEN,
  [string]$WorkerUrl = $env:WORKER_URL,
  [string]$WebhookSecret = $env:TELEGRAM_WEBHOOK_SECRET
)

if (-not $WebhookSecret) { $WebhookSecret = $env:TELEGRAM_SECRET }

function Show-BotMe($label, $token) {
  $me = Invoke-RestMethod "https://api.telegram.org/bot$token/getMe"
  if (-not $me.ok) { throw "getMe that bai ($label)" }
  Write-Host "  $label : @$($me.result.username) — $($me.result.first_name) (id $($me.result.id))"
  return $me.result
}

if (-not $BaocaoToken -or -not $ThuChiToken) {
  Write-Host "Can TELEGRAM_BOT_TOKEN (Bao cao) va TELEGRAM_THU_CHI_BOT_TOKEN (Thu Chi)"
  exit 1
}
if (-not $WorkerUrl) {
  $WorkerUrl = Read-Host "URL Worker"
}
$WorkerUrl = $WorkerUrl.Trim().TrimEnd("/")
$ThuChiWebhook = "$WorkerUrl/api/telegram-thu-chi-webhook"

Write-Host "=== Kiem tra ten bot (tranh nham token) ==="
$baocao = Show-BotMe "TELEGRAM_BOT_TOKEN" $BaocaoToken
$thuchi = Show-BotMe "TELEGRAM_THU_CHI_BOT_TOKEN" $ThuChiToken

Write-Host ""
Write-Host "=== Go webhook bot Bao cao ==="
Invoke-RestMethod "https://api.telegram.org/bot$BaocaoToken/deleteWebhook?drop_pending_updates=true" | Out-Null
Write-Host "  OK (Bao cao khong nhan webhook Worker)"

Write-Host ""
Write-Host "=== Bat webhook bot Thu Chi ==="
$body = @{ url = $ThuChiWebhook }
if ($WebhookSecret) { $body.secret_token = $WebhookSecret }
$res = Invoke-RestMethod -Uri "https://api.telegram.org/bot$ThuChiToken/setWebhook" -Method Post -ContentType "application/json; charset=utf-8" -Body ($body | ConvertTo-Json -Compress)
if (-not $res.ok) { Write-Host "Loi setWebhook Thu Chi: $($res | ConvertTo-Json)"; exit 1 }
Write-Host "  URL: $ThuChiWebhook"
Write-Host "  $($res.description)"

Write-Host ""
Write-Host "=== Webhook hien tai ==="
$bWh = (Invoke-RestMethod "https://api.telegram.org/bot$BaocaoToken/getWebhookInfo").result.url
$tWh = (Invoke-RestMethod "https://api.telegram.org/bot$ThuChiToken/getWebhookInfo").result.url
Write-Host "  Bao cao : $(if ($bWh) { $bWh } else { '(trong — dung)' })"
Write-Host "  Thu Chi : $tWh"

if ($bWh) {
  Write-Host ""
  Write-Host "CANH BAO: Bot Bao cao van con webhook — chay lai script hoac remove-telegram-webhook.ps1"
}

Write-Host ""
Write-Host "Cloudflare Secrets (Encrypt):"
Write-Host "  TELEGRAM_BOT_TOKEN = token @$($baocao.username)"
Write-Host "  TELEGRAM_THU_CHI_BOT_TOKEN = token @$($thuchi.username)"
Write-Host "Sau do: npm run deploy"
