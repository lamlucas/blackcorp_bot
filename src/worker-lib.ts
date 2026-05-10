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
  TELEGRAM_BOT_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  SESSION_SECRET: string;
  /** Chỉ đặt qua Cloudflare secret / .dev.vars — không để trong [vars] */
  PASSWORD?: string;
  /** Mặc định Black7777 nếu không khai báo */
  ADMIN_USERNAME?: string;
  MAIN_SPREADSHEET_ID: string;
  DEBT_TAB_NAME: string;
  PAYMENT_IMAGE_URL_1: string;
  PAYMENT_IMAGE_URL_2: string;
}

export async function getAccessTokenFromEnv(env: Env): Promise<string> {
  const sa = parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return getSheetsAccessToken(sa);
}

function quoteSheet(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

/** Ghi ô H2 = TỔNG THU (THỰC THU cột G + công nợ). Cần quyền Editor cho service account. */
export async function writeCellH2(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  value: string
): Promise<void> {
  const q = quoteSheet(sheetTitle);
  await sheetsPutValues(accessToken, spreadsheetId, `${q}!H2`, [[value]]);
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

export async function readTabRows(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string
): Promise<{ chatId: string | null; a1: string; row2: string[] }> {
  const q = quoteSheet(sheetTitle);
  const ranges = [`${q}!A1:B1`, `${q}!A2:H2`];
  const parts = await batchGetValues(accessToken, spreadsheetId, ranges);
  const header = parts[0]?.[0] ?? [];
  const data = parts[1]?.[0] ?? [];
  const a1 = String(header[0] ?? "").trim();
  const b1 = String(header[1] ?? "").trim();
  const chatId = b1 ? b1 : null;
  const row2 = [
    String(data[0] ?? ""),
    String(data[1] ?? ""),
    String(data[2] ?? ""),
    String(data[3] ?? ""),
    String(data[4] ?? ""),
    String(data[5] ?? ""),
    String(data[6] ?? ""),
    String(data[7] ?? ""),
  ];
  return { chatId, a1, row2 };
}

/** Hàng 2 trở đi cột A-B: tên đại lý (khớp tên tab) → nợ */
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
