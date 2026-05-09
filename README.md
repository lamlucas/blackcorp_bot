# Telegram + Google Sheet Broadcast (Cloudflare)

Website + bot Telegram theo nhu cau:
- Co trang dang nhap admin (`Black777777`) truoc khi vao form gui tin.
- Tren trang index co them giao dien quan ly `Tab Sheet ↔ Chat ID`.
- Form web nhap: NGAY, MCC, MA CAMP, RATE, RULE (nhieu dong).
- Bam GUI -> bot gui tin den tat ca nhom trong file map chat ID.
- Tu dong doc Google Sheet theo tung tab, moi tab ung voi 1 chat ID, va gui dong moi vao dung nhom.
- Noi dung gui Telegram duoc bo dam (`<b>...</b>`).

## 1) Cai dat local

```bash
npm install
```

Copy file bien moi truong:

```bash
copy .dev.vars.example .dev.vars
```

Cap nhat `.dev.vars`:
- `TELEGRAM_BOT_TOKEN`: token bot Telegram cua ban.
- `ADMIN_PASSWORD`: mat khau dang nhap admin (username co dinh: `Black777777`).
- `ADMIN_SESSION_SECRET`: secret ky session cookie (khuyen nghi dat chuoi dai ngau nhien).
- `GOOGLE_SERVICE_ACCOUNT_JSON`: toan bo JSON service account (1 dong).
- `GOOGLE_SHEET_ID`: `1nATFl9dlTfsYgoHiqoG0j-kpJu2aRim7wMwm2BEQlsI`
- `SYNC_API_KEY`: key de goi API sync thu cong (tu chon).

## 2) File map chat ID rieng

Mac dinh ban dau: sua file `src/chat-groups.json`:

```json
[
  { "tabName": "Noi_Bo", "chatId": "-1003978420142" },
  { "tabName": "Tab_Khac", "chatId": "-1001234567890" }
]
```

- `tabName` = ten tab trong Google Sheet.
- `chatId` = chat id nhom Telegram nhan tin.
- Sau khi deploy, ban co the them/sua/xoa truc tiep tren website (index), he thong se luu vao KV.

## 2.1) Mau file JSON service account

- Mau co san tai `google-service-account.example.json`.
- Lay noi dung file JSON that, thu gon ve 1 dong de gan vao `GOOGLE_SERVICE_ACCOUNT_JSON`.

## 3) Tao KV namespace (de luu dong da gui)

```bash
npx wrangler kv namespace create SHEET_STATE_KV
```

Lay `id` tra ve va dan vao `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SHEET_STATE_KV"
id = "ID_THAT_CLOUDFLARE_RETURNED"
```

## 4) Chay thu

```bash
npm run dev
```

Mo URL local de nhap form.

## 5) Deploy Cloudflare

```bash
npm run deploy
```

Sau deploy:
- Route `/login` la trang dang nhap admin.
- Route `/` la website index day du:
  - Quan ly `Ten tab` + `Chat ID`
  - Form broadcast gui tat ca nhom
- Cron `*/2 * * * *` tu dong quet Sheet moi 2 phut.
- Co the goi sync thu cong bang `POST /api/sync` kem header `x-sync-api-key`.

## 6) Luu y quan trong

- Chia se spreadsheet cho service account: `sheetbot@blacksheet.iam.gserviceaccount.com` voi quyen Viewer.
- Lan sync dau tien se **chi tao checkpoint** de tranh spam du lieu cu.
- Tu lan sau, neu tab co dong moi thi bot moi gui.
- Telegram dung `parse_mode=HTML`, du lieu duoc bao boi `<b>` de hien thi dam.
