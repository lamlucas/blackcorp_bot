import { formatDebtDisplayForTelegram } from "./format";
import {
  parseServiceAccountJson,
  getSheetsAccessToken,
  sheetsGet,
  sheetsPutValues,
  type SheetGrid,
  type BatchGetResponse,
} from "./google";

export interface Env {
  ASSETS: Fetcher;
  /** KV bắt buộc để Lưu đại lý + cron không trùng tin — khai báo trong Dashboard hoặc wrangler.toml */
  STORE?: KVNamespace;
  /** Bot « Black Corp - Báo cáo »: gửi chi phí / công nợ, nhận tin TỔNG TIỀN → CONG_NO */
  TELEGRAM_BOT_TOKEN: string;
  /** Bot « Black Corp - Thu Chi »: Thu:/Chi: → THU_CHI (nếu không đặt thì dùng TELEGRAM_BOT_TOKEN) */
  TELEGRAM_THU_CHI_BOT_TOKEN?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  SESSION_SECRET: string;
  /** Chỉ đặt qua Cloudflare secret / .dev.vars — không để trong [vars] */
  PASSWORD?: string;
  /** Mặc định Black7777 nếu không khai báo */
  ADMIN_USERNAME?: string;
  MAIN_SPREADSHEET_ID: string;
  /**
   * ID Sheet chứa công nợ (nếu không khai báo sẽ dùng MAIN_SPREADSHEET_ID để tương thích cũ).
   * Tab DEBT_TAB_NAME (vd CONG_NO): cột A = mã / tên đại lý; cột B = nợ hiện tại; cột C = nợ đầu ngày (00:00 VN, C = B).
   * Chat ID nhóm: map KV « Đại lý & Chat ID » (không dùng ô B1 cho gửi chi phí / cron công nợ).
   */
  DEBT_SPREADSHEET_ID?: string;
  DEBT_TAB_NAME: string;
  PAYMENT_IMAGE_URL_1: string;
  /** @deprecated Không dùng — chỉ gửi một ảnh PAYMENT_IMAGE_URL_1 */
  PAYMENT_IMAGE_URL_2?: string;
  /** "0" / "false" — không chạy cron gửi công nợ */
  DEBT_CRON_ENABLED?: string;
  /** Số nhóm gửi liền nhau trước khi nghỉ (cron); mặc định 6 */
  DEBT_CRON_BATCH_SIZE?: string;
  /** Millisecond nghỉ giữa các lô (cron); mặc định 4000 */
  DEBT_CRON_BATCH_PAUSE_MS?: string;
  /** Số tin chi phí / Telegram liên tiếp trước khi nghỉ dài (panel Gửi chi phí); mặc định 3 */
  SHEET_PAY_MSG_BATCH_SIZE?: string;
  /** Số nhóm gửi mỗi lô (panel Gửi tin hàng loạt); mặc định 2 */
  MANUAL_BROADCAST_BATCH_SIZE?: string;
  /**
   * Producer Cloudflare Queues (gửi công nợ). Có binding → cron/API chỉ enqueue; consumer gửi Telegram theo lô.
   * Không có → fallback gửi ngay trong Worker (DEV hoặc chưa tạo queue).
   */
  DEBT_NOTIFY_QUEUE?: Queue<{ chatId: string; maDl: string; noCuDisplay: string; runId: string }>;
  /** Hàng đợi gửi chi phí theo lô — tránh timeout / HTTP 522 khi Worker tự gọi HTTP. */
  SHEET_PAY_QUEUE?: Queue<import("./sheet-pay-queue").SheetPayQueueJob>;
  /** JSON mặc định tính tiền đại lý — `wrangler secret put KET_QUA_DEFAULTS_JSON` (GET /api/ket-qua-defaults-json) */
  KET_QUA_DEFAULTS_JSON?: string;
  /** "0" / "false" — tắt cron getUpdates (Thu:/Chi: + CONG_NO qua webhook Thu Chi). Mặc định bật. */
  TELEGRAM_POLL_ENABLED?: string;
  /** Nhóm hub « Black Corp - Thu Chi » — mặc định -1003727898214 */
  TELEGRAM_THU_CHI_CHAT_ID?: string;
  /** Sheet tab THU_CHI (TONG_QUAN / THU_CHI / COC) — mặc định 1Iik… */
  THU_CHI_SPREADSHEET_ID?: string;
  /** Sheet chấm công — mặc định 1rZY… */
  CHAM_CONG_SPREADSHEET_ID?: string;
  /** Nhóm « Chấm công - Black Corp » — mặc định -1003885146971 */
  CHAM_CONG_GROUP_CHAT_ID?: string;
  /**
   * Khớp `secret_token` lúc setWebhook và header `X-Telegram-Bot-Api-Secret-Token`.
   * Có thể đặt tên TELEGRAM_WEBHOOK_SECRET hoặc TELEGRAM_SECRET (Dashboard).
   */
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_SECRET?: string;
}

export async function getAccessTokenFromEnv(env: Env): Promise<string> {
  const sa = parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return getSheetsAccessToken(sa);
}

function quoteSheet(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

/** Tab tính tiền trên Sheet chi phí (MAIN_SPREADSHEET_ID), thứ tự 1…9. */
export const TINH_TIEN_TAB_NAMES = [
  "TINH_TIEN1",
  "TINH_TIEN2",
  "TINH_TIEN3",
  "TINH_TIEN4",
  "TINH_TIEN5",
  "TINH_TIEN6",
  "TINH_TIEN7",
  "TINH_TIEN8",
  "TINH_TIEN9",
] as const;

/** Ghi ô (cột + dòng) — ví dụ cột J = NOTE (Done/Error) trên BAO_CAO_TK. Cần quyền Editor. */
export async function writeSheetCell(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  colLetter: string,
  row1Based: number,
  value: string
): Promise<void> {
  const q = quoteSheet(sheetTitle);
  await sheetsPutValues(accessToken, spreadsheetId, `${q}!${colLetter}${row1Based}`, [[value]]);
}

export async function getSheetTitles(accessToken: string, spreadsheetId: string): Promise<string[]> {
  const grid = await sheetsGet<SheetGrid>(
    accessToken,
    `${spreadsheetId}?fields=sheets(properties(title,sheetType))`
  );
  const titles: string[] = [];
  for (const s of grid.sheets ?? []) {
    const t = s.properties?.title;
    if (t) titles.push(t);
  }
  return titles;
}

export async function batchGetValues(
  accessToken: string,
  spreadsheetId: string,
  ranges: string[]
): Promise<string[][][]> {
  const params = new URLSearchParams();
  for (const r of ranges) params.append("ranges", r);
  params.set("majorDimension", "ROWS");
  const path = `${spreadsheetId}/values:batchGet?${params.toString()}`;
  const data = await sheetsGet<BatchGetResponse>(accessToken, path);
  const out: string[][][] = [];
  for (const vr of data.valueRanges ?? []) {
    out.push(vr.values ?? []);
  }
  return out;
}

const PAYMENT_TAB_MAX_ROW = 200;

const PAYMENT_COL_COUNT = 9;

function padRowAtoI(raw: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < PAYMENT_COL_COUNT; i++) out.push(String(raw[i] ?? ""));
  return out;
}

/** Dừng tại dòng đầu tiên mà A–I đều trống (giữ block dữ liệu liên tục từ dòng 2). */
function slicePaymentDataRows(rawRows: unknown[][]): string[][] {
  const dataRows: string[][] = [];
  for (const raw of rawRows) {
    const row = padRowAtoI(raw);
    const ai = row.map((c) => c.trim());
    if (ai.every((c) => !c)) break;
    dataRows.push(row);
  }
  return dataRows;
}

/**
 * Đọc B1 (chat), các dòng dữ liệu A2:I… cho tới dòng trống A–I.
 * Cột: A NGÀY | B MCC | C TÀI KHOẢN | D TÊN KHÁCH (khớp CONG_NO cột A) | E RATE | F TỔNG TIÊU | G TIỀN TỆ | H QUY ĐỔI USD | I THỰC THU
 * `row2` = dòng đầu; `dataRows` = mọi dòng gửi chi phí.
 */
export async function readTabRows(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string
): Promise<{ chatId: string | null; a1: string; row2: string[]; dataRows: string[][] }> {
  const q = quoteSheet(sheetTitle);
  const lastRow = PAYMENT_TAB_MAX_ROW + 1;
  const ranges = [`${q}!A1:B1`, `${q}!A2:I${lastRow}`];
  const parts = await batchGetValues(accessToken, spreadsheetId, ranges);
  const header = parts[0]?.[0] ?? [];
  const rawRows = parts[1] ?? [];
  const a1 = String(header[0] ?? "").trim();
  const b1 = String(header[1] ?? "").trim();
  const chatId = b1 ? b1 : null;
  const dataRows = slicePaymentDataRows(rawRows);
  const emptyI = Array.from({ length: PAYMENT_COL_COUNT }, () => "");
  const row2 = dataRows[0] ? [...dataRows[0]] : [...emptyI];
  return { chatId, a1, row2, dataRows };
}

/** Hàng 2 trở đi cột A-B: tên cột A (mã đại lý / tên khách) → nợ cột B */
export async function getDebtMap(
  accessToken: string,
  spreadsheetId: string,
  tabName: string
): Promise<Map<string, string>> {
  const q = quoteSheet(tabName);
  const ranges = [`${q}!A2:B`];
  const parts = await batchGetValues(accessToken, spreadsheetId, ranges);
  const rows = parts[0] ?? [];
  const map = new Map<string, string>();
  for (const row of rows) {
    const name = String(row[0] ?? "").trim();
    const debt = String(row[1] ?? "").trim();
    if (name) map.set(name, debt);
  }
  return map;
}

/** Mọi dòng A2:B (không gộp trùng cột A); chỉ lấy dòng có cột A và cột B (nợ) sau trim. */
export async function getDebtRowsOrdered(
  accessToken: string,
  spreadsheetId: string,
  tabName: string
): Promise<{ maDl: string; noCuDisplay: string }[]> {
  const q = quoteSheet(tabName);
  const ranges = [`${q}!A2:B`];
  const parts = await batchGetValues(accessToken, spreadsheetId, ranges);
  const rows = parts[0] ?? [];
  const out: { maDl: string; noCuDisplay: string }[] = [];
  for (const row of rows) {
    const maDl = String(row[0] ?? "").trim();
    const noCu = String(row[1] ?? "").trim();
    if (!maDl || !noCu) continue;
    out.push({ maDl, noCuDisplay: formatDebtDisplayForTelegram(noCu) });
  }
  return out;
}
