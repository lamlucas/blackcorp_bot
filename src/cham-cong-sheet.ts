import {
  sheetsBatchUpdate,
  sheetsGet,
  sheetsPutValues,
  sheetsValuesAppend,
  sheetsValuesClear,
  type SheetGrid,
} from "./google";
import { batchGetValues } from "./worker-lib";

export const CHAM_CONG_TEMPLATE_TAB = "SU_BEO";
const MAX_ROW = 2000;

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export function formatNgayVietnam(unixSec?: number): string {
  const d = unixSec != null ? new Date(unixSec * 1000) : new Date();
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function parseVietnamDateCell(s: string): { y: number; m: number; d: number } | null {
  const t = String(s ?? "").trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  return { y, m: mo, d };
}

function vietnamDateKey(p: { y: number; m: number; d: number }): number {
  return p.y * 10000 + p.m * 100 + p.d;
}

function todayKey(unixSec?: number): number {
  const s = formatNgayVietnam(unixSec);
  const p = parseVietnamDateCell(s);
  return p ? vietnamDateKey(p) : 0;
}

function addCalendarDay(p: { y: number; m: number; d: number }): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function formatVietnamParts(p: { y: number; m: number; d: number }): string {
  const dd = String(p.d).padStart(2, "0");
  const mm = String(p.m).padStart(2, "0");
  return `${dd}/${mm}/${p.y}`;
}

async function getSheetIdByTitle(
  accessToken: string,
  spreadsheetId: string,
  title: string,
): Promise<number | null> {
  const grid = await sheetsGet<SheetGrid>(
    accessToken,
    `${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
  );
  for (const s of grid.sheets ?? []) {
    if (s.properties?.title === title && s.properties.sheetId != null) {
      return s.properties.sheetId;
    }
  }
  return null;
}

export type ChamCongRow = {
  sheetRow1Based: number;
  ngay: string;
  chamCong: boolean;
  tienUng: string;
};

function cellIsChecked(v: string): boolean {
  const t = String(v ?? "").trim().toUpperCase();
  return t === "TRUE" || t === "1" || t === "X" || t === "✓" || t === "V";
}

/** Đọc A2:C — A Ngày, B Chấm công, C Tiền ứng. */
export async function readChamCongRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
): Promise<ChamCongRow[]> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [`${q}!A2:C${MAX_ROW}`]);
  const rawRows = parts[0] ?? [];
  const out: ChamCongRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const cells = rawRows[i] ?? [];
    const ngay = String(cells[0] ?? "").trim();
    const chamCong = cellIsChecked(String(cells[1] ?? ""));
    const tienUng = String(cells[2] ?? "").trim();
    if (!ngay && !tienUng && !chamCong) break;
    if (!ngay && !chamCong && !tienUng) continue;
    out.push({
      sheetRow1Based: i + 2,
      ngay,
      chamCong,
      tienUng,
    });
  }
  return out;
}

/** Đọc ô C2 — tiền ứng mặc định. */
export async function readChamCongTienUngMacDinh(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
): Promise<string> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [`${q}!C2`]);
  return String(parts[0]?.[0]?.[0] ?? "").trim();
}

/** Ghi ô C2 — chỉ tiền ứng mặc định. */
export async function writeChamCongTienUngMacDinh(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  value: string | number,
): Promise<void> {
  const q = quoteSheet(tabName);
  await sheetsPutValues(accessToken, spreadsheetId, `${q}!C2`, [[value]], "USER_ENTERED");
}

/** Thêm dòng ngày mới (INSERT_ROWS) nếu hôm nay chưa có — giữ định dạng Sheet. */
export async function ensureTodayDateRow(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  unixSec?: number,
): Promise<number> {
  const rows = await readChamCongRows(accessToken, spreadsheetId, tabName);
  const today = todayKey(unixSec);
  const todayStr = formatNgayVietnam(unixSec);

  for (const r of rows) {
    const p = parseVietnamDateCell(r.ngay);
    if (p && vietnamDateKey(p) === today) return r.sheetRow1Based;
  }

  let lastParts: { y: number; m: number; d: number } | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const p = parseVietnamDateCell(rows[i]!.ngay);
    if (p) {
      lastParts = p;
      break;
    }
  }

  const q = quoteSheet(tabName);
  const datesToAdd: string[] = [];

  if (!lastParts) {
    datesToAdd.push(todayStr);
  } else {
    let cursor = lastParts;
    let cursorKey = vietnamDateKey(cursor);
    while (cursorKey < today) {
      cursor = addCalendarDay(cursor);
      cursorKey = vietnamDateKey(cursor);
      datesToAdd.push(formatVietnamParts(cursor));
    }
  }

  for (const ngay of datesToAdd) {
    await sheetsValuesAppend(
      accessToken,
      spreadsheetId,
      `${q}!A:A`,
      [[ngay]],
      "USER_ENTERED",
    );
  }

  const rowsAfter = datesToAdd.length > 0
    ? await readChamCongRows(accessToken, spreadsheetId, tabName)
    : rows;
  for (const r of rowsAfter) {
    const p = parseVietnamDateCell(r.ngay);
    if (p && vietnamDateKey(p) === today) return r.sheetRow1Based;
  }
  return rowsAfter.length > 0 ? rowsAfter[rowsAfter.length - 1]!.sheetRow1Based : 2;
}

/** Tick ô chấm công (cột B) cho hôm nay. */
export async function markChamCongToday(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  unixSec?: number,
): Promise<{ sheetRow: number; ngay: string }> {
  const sheetRow = await ensureTodayDateRow(accessToken, spreadsheetId, tabName, unixSec);
  const ngay = formatNgayVietnam(unixSec);
  const q = quoteSheet(tabName);
  await sheetsPutValues(accessToken, spreadsheetId, `${q}!B${sheetRow}`, [["TRUE"]], "USER_ENTERED");
  return { sheetRow, ngay };
}

/** Tạo tab nhân viên mới — copy cấu trúc SU_BEO, ngày đầu = hôm nay. */
export async function createChamCongEmployeeTab(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  templateTab: string = CHAM_CONG_TEMPLATE_TAB,
): Promise<void> {
  const titles = await sheetsGet<SheetGrid>(
    accessToken,
    `${spreadsheetId}?fields=sheets(properties(title))`,
  );
  const existing = new Set(
    (titles.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[],
  );
  if (existing.has(tabName)) {
    throw new Error(`Tab « ${tabName} » đã tồn tại trên Sheet.`);
  }

  const sourceId = await getSheetIdByTitle(accessToken, spreadsheetId, templateTab);
  if (sourceId == null) {
    throw new Error(`Không tìm thấy tab mẫu « ${templateTab} ».`);
  }

  await sheetsBatchUpdate(accessToken, spreadsheetId, [
    {
      duplicateSheet: {
        sourceSheetId: sourceId,
        newSheetName: tabName,
      },
    },
  ]);

  const today = formatNgayVietnam();
  const q = quoteSheet(tabName);
  await sheetsValuesClear(accessToken, spreadsheetId, `${q}!A3:C${MAX_ROW}`);
  await sheetsPutValues(
    accessToken,
    spreadsheetId,
    `${q}!A2:B2`,
    [[today, "FALSE"]],
    "USER_ENTERED",
  );
}

/** Xóa tab nhân viên trên Sheet (không xóa tab mẫu SU_BEO). */
export async function deleteChamCongEmployeeTab(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  templateTab: string = CHAM_CONG_TEMPLATE_TAB,
): Promise<void> {
  const name = tabName.trim();
  if (!name) throw new Error("Thiếu tên tab.");
  if (name === templateTab) {
    throw new Error(`Không thể xóa tab mẫu « ${templateTab} ».`);
  }

  const grid = await sheetsGet<SheetGrid>(
    accessToken,
    `${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
  );
  const sheets = grid.sheets ?? [];
  if (sheets.length <= 1) {
    throw new Error("Sheet chỉ còn một tab — không thể xóa.");
  }

  const target = sheets.find((s) => s.properties?.title === name);
  const sheetId = target?.properties?.sheetId;
  if (sheetId == null) {
    throw new Error(`Không tìm thấy tab « ${name} » trên Sheet.`);
  }

  await sheetsBatchUpdate(accessToken, spreadsheetId, [{ deleteSheet: { sheetId } }]);
}
