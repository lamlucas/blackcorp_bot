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
- `SHEET_COLUMN_LAYOUT` (tu chon): `legacy` (mac dinh) hoac `revenue`. **`revenue`** = **A** NGÀY, **B** MCC, **C** TỔNG TIÊU, **D** TIỀN TỆ, **E** QUY ĐỔI USD, **F** RATE, **G** THỰC THU, **H** TỔNG THU (= trên sheet: G + công nợ tab `CONG_NO` cột B nếu khớp tên). `legacy` cung map A–G nhu tren (khong bat buoc cot H).
- `MAIN_THUC_THU_COLUMN` (tu chon): chu cot (**`G`** mac dinh) — dong **THỰC THU** trong Telegram; neu khong co so trong cot **TỔNG THU** (`SHEET_TONG_THU_COLUMN`) thi bot tinh **THỰC THU + cot B** tab `CONG_NO`. Hoac `MAIN_THUC_THU_COL_INDEX`.
- `SHEET_TONG_THU_COLUMN` (tu chon): chu cot (**`H`** mac dinh) — uu tien hien thi **TỔNG THU** tu sheet (cong thuc). Hoac `SHEET_TONG_THU_COL_INDEX`.
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

## 2.2) Tab CÔNG NỢ (`CONG_NO`) trong cùng file sheet chính

- Bot **không** đọc spreadsheet khác. Tab **`CONG_NO`** nằm trong **cùng** file `GOOGLE_SHEET_ID` (`https://docs.google.com/spreadsheets/d/1nATFl9dlTfsYgoHiqoG0j-kpJu2aRim7wMwm2BEQlsI`).
- Cột **A** = tên đại lý (trùng **tên tab** từng DL), cột **B** = công nợ cũ; **C**, **D** (tuỳ chọn) = URL ảnh QR (`https://...`).
- Trên mỗi tab DL: cột **H** (mặc định) = **TỔNG THU** = công thức **THỰC THU cột G + đối chiếu `CONG_NO`**. Bot **ưu tiên** hiển thị giá trị ô **TỔNG THU** trên sheet; chỉ khi ô đó trống mới tính lại **G + B** (`CONG_NO`).
- Nếu không có URL ở C/D: dùng `TELEGRAM_PAYMENT_PHOTO_URL_1` và `TELEGRAM_PAYMENT_PHOTO_URL_2` (HTTPS, file ảnh công khai).
- Sau mỗi tin đồng bộ: bot **ghim** tin nhắn nội dung và gửi **tối đa 2 ảnh** (QR) **trả lời** tin đó. Bot cần quyền **Pin messages** trong nhóm.

**Khi `/api/sync` trả JSON:** `result.mainThucThuColumnIndex` (vd. 6 = G), `result.sheetTongThuColumnIndex` (vd. 7 = H); `result.congNo.sheetId` trùng `GOOGLE_SHEET_ID`; `error` khác `null` khi không đọc được tab `CONG_NO`.

**Ghim / ảnh không chạy:** (1) Bot = **Quản trị viên** nhóm, bật **Ghim tin nhắn**. (2) URL ảnh phải `https://` và mở được file ảnh; có thể set `TELEGRAM_PAYMENT_PHOTO_URL_1` / `_2` trên Cloudflare. (3) Cột **A** sheet `CONG_NO` phải trùng **tên tab** đã cấu hình trên web (không phân biệt hoa thường, khoảng trắng/`_` gần tương đương sau chuẩn hóa).

## 3) Tao KV namespace (de luu dong da gui)

Neu deploy bi loi `KV namespace ... is not valid` / code **10042**: ban chua thay `PUT_YOUR_KV_NAMESPACE_ID_HERE` trong `wrangler.toml` bang ID that.

```bash
npx wrangler kv namespace create SHEET_STATE_KV
```

Lay `id` tra ve (dang UUID) va dan vao `wrangler.toml` cho **ca hai** `id` va `preview_id`:

```toml
[[kv_namespaces]]
binding = "SHEET_STATE_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
preview_id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Hoac tren Dashboard: Workers & Pages -> Worker `blackcorp-bot` -> Settings -> Variables -> KV Namespace Bindings -> them binding `SHEET_STATE_KV` roi copy `Namespace ID` vao file.

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
- Co the goi sync thu cong bang `POST /api/sync` kem header `x-sync-api-key` hoac dang nhap admin.

**Cach dong bo sheet chinh (hang 1 = tieu de):**
- Bot luu **chu ky (hash) tung dong** (cac cot theo layout + cot THỰC THU + cot TỔNG THU tren sheet). Moi lan sync: **dong moi** hoac **dong cu bi sua** se **gui lai Telegram** cho dung nhom.
- Lan dau (chua co snapshot trong KV): chi **luu snapshot**, **khong gui** — tranh spam; de gui het dong hien co mot lan: `POST /api/sync?catch_up=1`.
- `POST /api/reset-sheet-checkpoints`: xoa snapshot; lan sync sau lai nhu lan dau (co the kem `catch_up=1`).
- **Luu y:** Chen/xoa dong **o giua** sheet lam lech chi so dong — co the gui trung hoac thong bao sai dong; nen **them dong o cuoi** va **sua tren cung mot dong** khi co the.

## 6) Luu y quan trong

- Chia se spreadsheet cho service account: `sheetbot@blacksheet.iam.gserviceaccount.com` voi quyen Viewer.
- Hang 1 moi tab sheet chinh la **tieu de**; du lieu bat dau hang 2.
- Bot gui lai khi co **dong moi** hoac **noi dung dong da co thay doi** (layout **va** cot THỰC THU **G**, cot **TỔNG THU H**).
- Telegram dung `parse_mode=HTML`, du lieu duoc bao boi `<b>` de hien thi dam.
