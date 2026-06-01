# Bot « Black Corp - Báo cáo » KHÔNG cần webhook Worker (chi gửi tin từ panel/cron).
# Mặc định script này GỠ webhook. Để bật webhook Thu Chi + CONG_NO:
#   .\scripts\set-telegram-thu-chi-webhook.ps1
#
# $env:TELEGRAM_BOT_TOKEN = "<token Black Corp - Bao cao>"
# .\scripts\set-telegram-webhook.ps1

& "$PSScriptRoot\remove-telegram-webhook.ps1" @PSBoundParameters
