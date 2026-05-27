import { batchGetValues } from "./worker-lib";

export const BAO_CAO_TK_TAB_NAME = "BAO_CAO_TK";
/** Số ô nhập NGÀY trên panel « Gửi chi phí ». */
export const BAO_CAO_PAYMENT_SLOT_COUNT = 3;

const MAX_ROW = 500;
const COL_COUNT = 13;

/** Cột tab BAO_CAO_TK (hàng 1 tiêu đề). */
export const BAO_CAO_COL = {
  NGAY: 0,
  MCC: 1,
  TAI_KHOAN: 2,
  TEN_KHACH: 3,
  RATE: 4,
  TONG_TIEU: 5,
  TIEN_TE: 6,
  QUY_DOI_USD: 7,
  TONG_THU: 8,
  LINK_FILE: 12,
} as const;

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function padRow(raw: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < COL_COUNT; i++) out.push(String(raw[i] ?? ""));
  return out;
}

export function normalizePanelDateKey(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

type DateParts = { y: number; m: number; d: number };

/** dd/mm/yyyy, d/m/yy — không parse dạng 13-14/5 (phải khớp chuỗi đúng). */
export function parseFlexibleDateParts(s: string): DateParts | null {
  const t = normalizePanelDateKey(s);
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const month = Number(m[2]);
  const day = Number(m[1]);
  if (!Number.isFinite(y) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { y, m: month, d: day };
}

function sameCalendarDate(a: string, b: string): boolean {
  const pa = parseFlexibleDateParts(a);
  const pb = parseFlexibleDateParts(b);
  if (pa && pb) return pa.y === pb.y && pa.m === pb.m && pa.d === pb.d;
  const na = normalizePanelDateKey(a).toLowerCase();
  const nb = normalizePanelDateKey(b).toLowerCase();
  return Boolean(na && nb && na === nb);
}

/** Chuẩn hóa danh sách ngày từ panel (tối đa 3 ô, bỏ trống). */
export function parseFilterDatesFromPanel(raw: unknown[]): string[] {
  return parseFilterSlotsFromPanel(raw, []).map((s) => s.panelNgay);
}

export type BaoCaoFilterSlot = { panelNgay: string; panelMcc: string };

/** Chuẩn hóa MCC (cột B) để so khớp — bỏ khoảng thừa, không phân biệt hoa thường. */
export function normalizeMccKey(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Cột B khớp ô MCC panel (trùng hoặc chứa chuỗi con). */
export function matchMccForRow(rowMcc: string, panelMcc: string): boolean {
  const b = normalizeMccKey(panelMcc);
  if (!b) return true;
  const a = normalizeMccKey(rowMcc);
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Tối đa 3 cặp (NGÀY, MCC) từ panel — MCC trống = chỉ lọc theo ngày. */
export function parseFilterSlotsFromPanel(dates: unknown[], mccs: unknown[]): BaoCaoFilterSlot[] {
  const out: BaoCaoFilterSlot[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < BAO_CAO_PAYMENT_SLOT_COUNT; i++) {
    const panelNgay = normalizePanelDateKey(String(dates[i] ?? ""));
    if (!panelNgay) continue;
    const panelMcc = normalizeMccKey(String(mccs[i] ?? ""));
    const sig = (() => {
      const p = parseFlexibleDateParts(panelNgay);
      const d = p ? `${p.y}-${p.m}-${p.d}` : panelNgay.toLowerCase();
      return `${d}|${panelMcc}`;
    })();
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ panelNgay, panelMcc });
  }
  return out;
}

/** Cột A khớp một ngày panel → trả về chuỗi ngày user nhập (hiển thị NGÀY trong tin). */
export function matchPanelDateForRow(rowNgay: string, panelDate: string): boolean {
  if (!normalizePanelDateKey(rowNgay) || !normalizePanelDateKey(panelDate)) return false;
  return sameCalendarDate(rowNgay, panelDate);
}

/** Dòng chi phí hợp lệ: có tên khách cột D. */
export function isBaoCaoTkDataRow(row: string[]): boolean {
  return Boolean(String(row[BAO_CAO_COL.TEN_KHACH] ?? "").trim());
}

export function hashBaoCaoTkRowSnapshot(row: string[]): string {
  return row
    .slice(0, COL_COUNT)
    .map((c) => String(c ?? "").trim())
    .join("\x1e");
}

export type BaoCaoTkSheetRow = { sheetRow1Based: number; cells: string[] };

/** Dòng đã lọc — `panelNgay` = ngày nhập trên website (không dùng cột A để hiển thị). */
export type BaoCaoTkFilteredRow = BaoCaoTkSheetRow & { panelNgay: string };

/** Đọc dòng 2+ tab BAO_CAO_TK (A:M), giữ số dòng Sheet. */
export async function readBaoCaoTkSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string = BAO_CAO_TK_TAB_NAME,
): Promise<BaoCaoTkSheetRow[]> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [`${q}!A2:M${MAX_ROW}`]);
  const rawRows = parts[0] ?? [];
  const dataRows: BaoCaoTkSheetRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = padRow(rawRows[i]);
    if (!isBaoCaoTkDataRow(row)) {
      /* Không break — tránh dừng đọc khi có dòng trống giữa các ngày trên Sheet. */
      continue;
    }
    dataRows.push({ sheetRow1Based: i + 2, cells: row });
  }
  return dataRows;
}

/**
 * Gộp dòng: cột A trùng ngày panel; nếu ô MCC có giá trị thì cột B phải khớp MCC.
 */
export function filterBaoCaoSheetRowsBySlots(
  entries: BaoCaoTkSheetRow[],
  slots: BaoCaoFilterSlot[],
): BaoCaoTkFilteredRow[] {
  const bySheetRow = new Map<number, BaoCaoTkFilteredRow>();
  for (const slot of slots) {
    const panel = normalizePanelDateKey(slot.panelNgay);
    if (!panel) continue;
    for (const e of entries) {
      const rowA = String(e.cells[BAO_CAO_COL.NGAY] ?? "");
      const rowB = String(e.cells[BAO_CAO_COL.MCC] ?? "");
      if (!matchPanelDateForRow(rowA, panel)) continue;
      if (!matchMccForRow(rowB, slot.panelMcc)) continue;
      bySheetRow.set(e.sheetRow1Based, { ...e, panelNgay: panel });
    }
  }
  return [...bySheetRow.values()].sort((a, b) => a.sheetRow1Based - b.sheetRow1Based);
}

/** @deprecated dùng filterBaoCaoSheetRowsBySlots */
export function filterBaoCaoSheetRowsByDates(
  entries: BaoCaoTkSheetRow[],
  filterDates: string[],
): BaoCaoTkFilteredRow[] {
  return filterBaoCaoSheetRowsBySlots(
    entries,
    filterDates.map((d) => ({ panelNgay: d, panelMcc: "" })),
  );
}
